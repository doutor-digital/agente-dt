/**
 * Captura silenciosa: a IA lê a conversa do cartão quando a Sofia não fala e preenche SÓ os campos vazios que a etapa pede.
 * Sem banco, sem Kommo e sem IA de verdade: as dependências são trocadas.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { LeadFieldRule, Unit } from '@prisma/client';
import { KommoApiError, type KommoLead } from '../services/kommo.service.js';
import type { DefinicaoDeCampo } from './ponte-ligacao.js';
import type { Fala } from './cutucada-apos-equipe.js';
import type { Estado } from './automacoes-estado.js';
import {
  CAMPOS_CAPTURAVEIS,
  DEBOUNCE_MS,
  MAX_LEITURAS_POR_CARTAO_DIA,
  MAX_TENTATIVAS_DE_AUDIO,
  PRAZO_DA_LEITURA_MS,
  falaDeOutraPessoa,
  falaDeOutraPessoaNoContexto,
  chaveDaPalavra,
  numerosDoTexto,
  palavrasForaDaFala,
  _limparCapturaParaTeste,
  agendadosDaCaptura,
  agendarCapturaSilenciosa,
  camposDaEtapaVazios,
  lerCartaoEmSilencio,
  lerResposta,
  montarPedido,
  opcoesPermitidas,
  porQueNaoCapturar,
  validarSugestoes,
  type DepsDaCaptura,
} from './captura-silenciosa.js';
import { AUTOMACOES, verificarCatalogo } from './automacoes.js';

const COMERCIAL = 100;
const TRATAMENTO = 200;
const QUALIFICACAO = 10;
const ESPERA = 11;
const UNIT = { id: 'u-pet', slug: 'petropolis', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
const AGORA = new Date('2026-11-16T15:00:00Z');

const def = (id: number, name: string, type: string, extra: Partial<DefinicaoDeCampo> & { sort?: number; is_api_only?: boolean } = {}): DefinicaoDeCampo => ({ id, name, type, enums: [], ...extra }) as DefinicaoDeCampo;
const naoNaQualificacao = [{ pipeline_id: COMERCIAL, status_id: ESPERA }];
const escondidoNaQualificacao = [{ pipeline_id: COMERCIAL, status_id: QUALIFICACAO }];

const DEFS: DefinicaoDeCampo[] = [
  def(1, '✎ Queixa', 'textarea', { sort: 1, hidden_statuses: naoNaQualificacao }),
  def(2, '★ Qualificação (Quente/Morno/Frio)', 'select', { sort: 2, enums: [{ id: 21, value: 'Quente' }, { id: 22, value: 'Morno' }, { id: 23, value: 'Frio' }], hidden_statuses: naoNaQualificacao }),
  def(3, '⌂ Cidade', 'textarea', { sort: 3, hidden_statuses: [{ pipeline_id: COMERCIAL, status_id: QUALIFICACAO }, ...naoNaQualificacao] }),
  def(4, '⬢ Tipo de lead', 'select', { sort: 4, enums: [{ id: 41, value: 'Cadastro' }, { id: 42, value: 'Resgate' }] }),
  def(5, '⚑ Origem', 'select', { sort: 5, enums: [{ id: 51, value: 'Indicação' }, { id: 52, value: 'Instagram' }, { id: 53, value: 'Meta-Instagram' }], hidden_statuses: naoNaQualificacao }),
  def(6, '⌂ Campanha', 'text', { sort: 6 }),
  def(7, '⚕ Região da dor', 'multiselect', { sort: 7, enums: [{ id: 71, value: 'Lombar' }, { id: 72, value: 'Cervical' }], hidden_statuses: naoNaQualificacao }),
  def(8, '✎ Observações', 'textarea', { sort: 8, hidden_statuses: naoNaQualificacao }),
  def(9, '⌂ Estado', 'text', { sort: 9, is_api_only: true }),
];

function regra(toolName: string, kommoFieldId: number, kommoFieldName: string, kommoFieldType: string, extra: Partial<LeadFieldRule> = {}): LeadFieldRule {
  return { id: toolName, unitId: UNIT.id, kommoFieldId, kommoFieldName, kommoFieldType, kommoFieldEnums: null, toolName, instruction: `quando o paciente disser ${kommoFieldName}`, valueHint: null, examples: [], enabled: true, updatesLeadTitle: false, createdAt: AGORA, updatedAt: AGORA, ...extra } as LeadFieldRule;
}
const REGRAS: LeadFieldRule[] = [
  regra('registra_queixa', 1, '✎ Queixa', 'textarea'),
  regra('registra_qualificacao', 2, '★ Qualificação (Quente/Morno/Frio)', 'select'),
  regra('registra_cidade', 3, '⌂ Cidade', 'textarea'),
  regra('registra_tipo_lead', 4, '⬢ Tipo de lead', 'select'),
  regra('registra_origem', 5, '⚑ Origem', 'select'),
  regra('registra_regiao_dor', 7, '⚕ Região da dor', 'multiselect'),
  regra('registra_observacoes', 8, '✎ Observações', 'textarea'),
  regra('registra_estado', 9, '⌂ Estado', 'text'),
];

function lead(extra: Partial<KommoLead> & { preenchidos?: Array<[number, string]> } = {}): KommoLead {
  const { preenchidos = [], ...resto } = extra;
  return {
    id: 777,
    name: 'Lead 7 16/11/2026',
    pipeline_id: COMERCIAL,
    status_id: QUALIFICACAO,
    custom_fields_values: preenchidos.map(([field_id, value]) => ({ field_id, values: [{ value }] })),
    _embedded: { tags: [], contacts: [{ id: 5, is_main: true }] },
    ...resto,
  } as KommoLead;
}

const fala = (autor: Fala['autor'], texto: string, minutosAtras = 30, anexo: string | null = null): Fala => ({ id: `${autor}-${texto.slice(0, 6)}-${minutosAtras}`, em: new Date(AGORA.getTime() - minutosAtras * 60_000), autor, autorNome: autor, texto, anexo });
const CONVERSA: Fala[] = [
  fala('paciente', 'Oi, boa tarde', 60),
  fala('equipe', 'Boa tarde! Em que posso ajudar?', 55),
  fala('paciente', 'Tenho uma dor forte na lombar há 3 meses e desce para a perna', 50),
  fala('equipe', 'Entendi. A avaliação custa R$ 350.', 45),
  fala('paciente', 'Fiquei sabendo por indicação de uma amiga, quero marcar logo', 40),
];

interface Mundo {
  deps: DepsDaCaptura;
  estado: { v: Estado };
  escritas: Array<{ campo: number; valor: unknown }>;
  /** quantos PATCH de campos saíram (a gravação é em lote: um por cartão) */
  lotes: { n: number };
  /** `preenche-campos` ligado na unidade? (ele é o escritor da Qualificação) */
  robo: { v: boolean };
  notas: string[];
  simulacoes: Array<{ acao: string; alvo: string; valor?: unknown; motivo?: string | null }>;
  perguntas: string[];
  leituras: { lead: number; conversa: number };
  transcricoes: { n: number; faltam: number };
  cartao: { atual: KommoLead };
  resposta: { texto: string | null };
}

function mundo(o: { lead?: KommoLead; falas?: Fala[]; estado?: Estado; resposta?: string | null; relido?: () => KommoLead } = {}): Mundo {
  const estado = { v: o.estado ?? 'ligado' };
  const cartao = { atual: o.lead ?? lead() };
  const m: Mundo = {
    estado,
    escritas: [],
    lotes: { n: 0 },
    robo: { v: false },
    notas: [],
    simulacoes: [],
    perguntas: [],
    leituras: { lead: 0, conversa: 0 },
    transcricoes: { n: 0, faltam: 0 },
    cartao,
    resposta: { texto: o.resposta === undefined ? JSON.stringify({ campos: [{ campo: '✎ Queixa', valor: 'Dor forte na lombar há 3 meses, desce para a perna', trecho: 'dor forte na lombar há 3 meses e desce para a perna' }] }) : o.resposta },
    deps: null as never,
  };
  m.deps = {
    agora: () => AGORA,
    unidade: async (u) => u as Unit,
    estado: () => estado.v,
    qualificacaoEhDoRobo: () => m.robo.v,
    kommo: () => ({
      getLead: async () => {
        m.leituras.lead++;
        return o.relido && m.leituras.lead > 1 ? o.relido() : cartao.atual;
      },
      getContactPhone: async () => '5524988887777',
      gravarCamposDoLead: async (_l: number, campos: Array<{ field_id: number; values: unknown }>) => {
        m.lotes.n++;
        for (const c of campos) m.escritas.push({ campo: c.field_id, valor: c.values });
      },
      addLeadNote: async (_l: number, t: string) => (m.notas.push(t), { id: 1 }),
    }),
    regras: async () => REGRAS,
    funis: async () => ({ comercialId: COMERCIAL, tratamentoId: TRATAMENTO, nomeDe: (p: number, s: number) => (p === COMERCIAL && s === QUALIFICACAO ? { funil: 'COMERCIAL', status: 'EM QUALIFICAÇÃO' } : null) as never }),
    campos: async () => DEFS,
    grupo: async () => null,
    falas: async () => {
      m.leituras.conversa++;
      return { falas: o.falas ?? CONVERSA, ultimaId: `m${(o.falas ?? CONVERSA).length}`, audios: new Map<string, string>() };
    },
    transcrever: async () => (m.transcricoes.n++, m.transcricoes.faltam),
    perguntar: async (_u, user) => {
      m.perguntas.push(user);
      return m.resposta.texto === null ? null : { texto: m.resposta.texto, custoUsd: 0.0009 };
    },
    simular: (_u, _a, s) => void m.simulacoes.push({ acao: s.acao, alvo: s.alvo, valor: s.valor, motivo: s.motivo }),
  } as DepsDaCaptura;
  return m;
}

beforeEach(() => {
  _limparCapturaParaTeste();
  process.env.NUMEROS_INTERNOS = 'recepcao:5524999990001';
});
afterEach(() => mock.timers.reset());

// ─── quais campos ─────────────────────────────────────────────────────────────────────────────────

test('só os campos da etapa: o que está escondido nela (Cidade) não entra', () => {
  const c = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const nomes = c.map((x) => x.def.name);
  assert.ok(nomes.includes('✎ Queixa'));
  assert.ok(nomes.includes('★ Qualificação (Quente/Morno/Frio)'));
  assert.ok(!nomes.includes('⌂ Cidade'), 'Cidade está escondida em EM QUALIFICAÇÃO');
});

test('na outra etapa o conjunto muda: EM ESPERA esconde a Queixa, e Cidade continua escondida', () => {
  const c = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead({ status_id: ESPERA }) });
  assert.deepEqual(c.map((x) => x.def.name), []);
});

test('só os VAZIOS: campo com valor (da SDR ou da IA) nunca é candidato', () => {
  const c = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead({ preenchidos: [[1, 'dor nas costas (a SDR escreveu)'], [2, 'Morno']] }) });
  const nomes = c.map((x) => x.def.name);
  assert.ok(!nomes.includes('✎ Queixa'));
  assert.ok(!nomes.includes('★ Qualificação (Quente/Morno/Frio)'));
  assert.ok(nomes.includes('⚕ Região da dor'));
});

test('campo de OUTRO robô (Tipo de lead) e regra desligada ficam de fora, mesmo vazios e visíveis', () => {
  const c = camposDaEtapaVazios({ regras: [...REGRAS.map((r) => (r.toolName === 'registra_queixa' ? { ...r, enabled: false } : r))], defs: DEFS, lead: lead() });
  const nomes = c.map((x) => x.def.name);
  assert.ok(!nomes.includes('⬢ Tipo de lead'));
  assert.ok(!nomes.includes('✎ Queixa'), 'regra desligada pela unidade');
  assert.ok(!CAMPOS_CAPTURAVEIS.has('registra_tipo_lead') && !CAMPOS_CAPTURAVEIS.has('registra_motivo_perda') && !CAMPOS_CAPTURAVEIS.has('salvar_retomar_em'));
});

test('campo "Apenas API" não aparece na tela da SDR: não é candidato', () => {
  const c = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  assert.ok(!c.some((x) => x.def.id === 9));
});

test('Origem: cartão com rastro de anúncio (campanha preenchida) não recebe origem da conversa', () => {
  const sem = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() }).map((x) => x.def.name);
  assert.ok(sem.includes('⚑ Origem'));
  const com = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead({ preenchidos: [[6, 'DH Petrópolis · Coluna']] }) }).map((x) => x.def.name);
  assert.ok(!com.includes('⚑ Origem'));
});

// ─── quem fica de fora ────────────────────────────────────────────────────────────────────────────

test('exclusões: TRATAMENTO, fora do COMERCIAL, fechado e currículo', () => {
  const funis = { comercialId: COMERCIAL, tratamentoId: TRATAMENTO };
  assert.match(porQueNaoCapturar({ lead: lead({ pipeline_id: TRATAMENTO }), funis }) ?? '', /TRATAMENTO/);
  assert.match(porQueNaoCapturar({ lead: lead({ pipeline_id: 999 }), funis }) ?? '', /fora do funil/);
  assert.match(porQueNaoCapturar({ lead: lead({ status_id: 142 }), funis }) ?? '', /fechado/);
  assert.match(porQueNaoCapturar({ lead: lead({ status_id: 143 }), funis }) ?? '', /fechado/);
  assert.match(porQueNaoCapturar({ lead: lead({ closed_at: 1760000000 }), funis }) ?? '', /fechado/);
  assert.match(porQueNaoCapturar({ lead: lead({ _embedded: { tags: [{ id: 1, name: 'CURRÍCULO' }], contacts: [] } }), funis }) ?? '', /currículo/);
  assert.equal(porQueNaoCapturar({ lead: lead(), funis }), null);
});

// ─── a resposta da IA ─────────────────────────────────────────────────────────────────────────────

test('lerResposta aceita JSON dentro de ``` e recusa o que não é JSON', () => {
  assert.equal(lerResposta('não sei')?.length, undefined);
  assert.deepEqual(lerResposta('```json\n{"campos":[]}\n```'), []);
  assert.equal(lerResposta('```json\n{"campos":[{"campo":"x","valor":"y"}]}\n```')?.[0].trecho, '');
});

test('validar: valor com frase do paciente passa; frase que o paciente NÃO disse é recusada', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const ok = validarSugestoes([{ campo: '✎ Queixa', valor: 'Dor lombar há 3 meses', trecho: 'dor forte na lombar há 3 meses' }], cands, CONVERSA);
  assert.equal(ok.aceitas.length, 1);
  assert.equal(ok.aceitas[0].texto, 'Dor lombar há 3 meses');
  const palpite = validarSugestoes([{ campo: '✎ Queixa', valor: 'Hérnia de disco', trecho: 'tenho hérnia de disco' }], cands, CONVERSA);
  assert.equal(palpite.aceitas.length, 0);
  assert.match(palpite.recusadas[0].motivo, /não está numa fala do paciente/);
});

test('validar: a frase que só a EQUIPE disse não prova nada sobre o paciente', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const r = validarSugestoes([{ campo: '⚑ Origem', valor: 'Instagram', trecho: 'A avaliação custa R$ 350' }], cands, CONVERSA);
  assert.equal(r.aceitas.length, 0);
});

test('validar: opção que não existe na lista do campo é recusada (não inventa "Outro")', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const r = validarSugestoes([{ campo: '⚑ Origem', valor: 'Rádio', trecho: 'indicação de uma amiga' }], cands, CONVERSA);
  assert.equal(r.aceitas.length, 0);
  assert.match(r.recusadas[0].motivo, /opção inválida/);
});

test('validar: a Origem nunca vira opção do rastreio (Meta-Instagram) por uma frase solta, nem "Não informada" na região', () => {
  const defs = DEFS.map((d) => (d.id === 7 ? { ...d, enums: [...(d.enums ?? []), { id: 79, value: 'Não informada' }] } : d));
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs, lead: lead() });
  const origem = cands.find((c) => c.def.id === 5)!;
  assert.deepEqual(opcoesPermitidas(origem).map((o) => o.value), ['Indicação', 'Instagram']);
  const conversa = [...CONVERSA, fala('paciente', 'estava navegando e vi o anúncio')];
  const r = validarSugestoes(
    [
      { campo: '⚑ Origem', valor: 'Meta-Instagram', trecho: 'estava navegando' },
      { campo: '⚕ Região da dor', valor: 'Não informada', trecho: 'dor forte na lombar' },
    ],
    cands,
    conversa,
  );
  assert.equal(r.aceitas.length, 0);
  assert.ok(montarPedido(cands, conversa).includes('Opções: Indicação | Instagram.'));
  assert.ok(!montarPedido(cands, conversa).includes('Meta-Instagram'));
});

test('validar: campo de lista cujas opções todas são vetadas não aceita texto livre', () => {
  const defs = DEFS.map((d) => (d.id === 5 ? { ...d, enums: [{ id: 53, value: 'Meta-Instagram' }] } : d));
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs, lead: lead() });
  const r = validarSugestoes([{ campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' }], cands, CONVERSA);
  assert.equal(r.aceitas.length, 0);
  assert.match(r.recusadas[0].motivo, /não tem opção/);
});

test('validar: PARÁFRASE — o caso real do "formigamento" (o paciente escreveu «nada pernas») é recusado', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const conversa = [fala('paciente', 'dor na lombar ,colicas dor no quadril e nada pernas'), fala('paciente', 'tem uns 5 meses já, queria saber o valor')];
  const inventado = 'Dor na lombar com cólicas, dor no quadril e formigamento nas pernas, há cerca de 5 meses.';
  const r = validarSugestoes([{ campo: '✎ Queixa', valor: inventado, trecho: 'dor na lombar ,colicas dor no quadril e nada pernas' }], cands, conversa);
  assert.equal(r.aceitas.length, 0);
  assert.match(r.recusadas[0].motivo, /valor com detalhe que o paciente não disse \(formigamento\)/);
  // sem o detalhe, o mesmo valor passa (as palavras de conteúdo são todas dele; «cerca», «sobre» e afins não contam)
  const fiel = validarSugestoes([{ campo: '✎ Queixa', valor: 'Dor na lombar com cólicas, dor no quadril e nas pernas, há cerca de 5 meses.', trecho: 'dor na lombar ,colicas dor no quadril e nada pernas' }], cands, conversa);
  assert.equal(fiel.aceitas.length, 1);
});

test('validar: Observações também — resumo com detalhe que o paciente não escreveu é recusado; o fiel passa', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const conversa = [fala('paciente', 'Tenho exames de imagem com protrusão na cervical'), fala('equipe', 'Pode mandar as fotos do exame')];
  const r1 = validarSugestoes([{ campo: '✎ Observações', valor: 'Paciente tem exames com protrusão na cervical e já fez cirurgia.', trecho: '' }], cands, conversa);
  assert.equal(r1.aceitas.length, 0);
  assert.match(r1.recusadas[0].motivo, /cirurgia/);
  const r2 = validarSugestoes([{ campo: '✎ Observações', valor: 'Paciente informou exames de imagem com protrusão na cervical.', trecho: '' }], cands, conversa);
  assert.equal(r2.aceitas.length, 1);
});

test('validar: a 1ª sugestão inválida de um campo não derruba a 2ª válida; a repetição depois de aceita é registrada, não engolida', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const r = validarSugestoes(
    [
      { campo: '⚑ Origem', valor: 'Rádio', trecho: 'indicação de uma amiga' },
      { campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' },
      { campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' },
    ],
    cands,
    CONVERSA,
  );
  assert.deepEqual(r.aceitas.map((a) => a.texto), ['Indicação']);
  assert.equal(r.recusadas.length, 1, 'só a opção inválida; o eco do valor aceito não vira ruído');
  assert.match(r.recusadas[0].motivo, /opção inválida/);
});

test('validar: cidade e UF só valem ditas por inteiro ("Magé", "RJ"); «mage» dentro de «imagem» não vale', () => {
  const regras = [...REGRAS, regra('registra_cidade', 3, '⌂ Cidade', 'textarea')];
  const defs = DEFS.map((d) => (d.id === 3 ? { ...d, hidden_statuses: [] } : d.id === 9 ? { ...d, is_api_only: false } : d));
  const cands = camposDaEtapaVazios({ regras, defs, lead: lead() });
  const diz = (t: string) => [...CONVERSA, fala('paciente', t)];
  assert.equal(validarSugestoes([{ campo: '⌂ Cidade', valor: 'Magé', trecho: 'sou de Magé' }], cands, diz('sou de Magé, perto do centro')).aceitas.length, 1);
  assert.equal(validarSugestoes([{ campo: '⌂ Estado', valor: 'RJ', trecho: 'moro em Magé RJ' }], cands, diz('moro em Magé RJ')).aceitas.length, 1);
  const imagem = validarSugestoes([{ campo: '⌂ Cidade', valor: 'Magé', trecho: 'mandei a imagem do exame' }], cands, diz('mandei a imagem do exame'));
  assert.equal(imagem.aceitas.length, 0);
  assert.match(imagem.recusadas[0].motivo, /não aparece escrito/);
});

test('validar: campo que não foi pedido (Tipo de lead, Cidade escondida) é recusado, e o repetido conta uma vez', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const r = validarSugestoes(
    [
      { campo: '⬢ Tipo de lead', valor: 'Cadastro', trecho: 'oi' },
      { campo: '⌂ Cidade', valor: 'Petrópolis', trecho: 'oi' },
      { campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' },
      { campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' },
    ],
    cands,
    CONVERSA,
  );
  assert.equal(r.aceitas.length, 1);
  assert.equal(r.recusadas.length, 2, 'Tipo de lead e Cidade não pedidos; a repetição idêntica da Origem é só eco');
});

test('validar: Qualificação e Observações dispensam a frase, mas Qualificação pede 2 falas do paciente', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const poucas = [fala('paciente', 'Oi'), fala('equipe', 'Olá!')];
  const a = validarSugestoes([{ campo: '★ Qualificação (Quente/Morno/Frio)', valor: 'quente', trecho: '' }, { campo: '✎ Observações', valor: 'Quer marcar', trecho: '' }], cands, CONVERSA);
  assert.deepEqual(a.aceitas.map((x) => x.texto), ['Quente', 'Quer marcar']);
  const b = validarSugestoes([{ campo: '★ Qualificação (Quente/Morno/Frio)', valor: 'Quente', trecho: '' }], cands, poucas);
  assert.equal(b.aceitas.length, 0);
  assert.match(b.recusadas[0].motivo, /cedo para qualificar/);
});

test('validar: lista múltipla (região da dor) vira vetor e aceita a opção por nome parcial', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const r = validarSugestoes([{ campo: '⚕ Região da dor', valor: 'lombar', trecho: 'dor forte na lombar' }], cands, CONVERSA);
  assert.deepEqual(r.aceitas[0].valor, ['Lombar']);
});

test('o pedido mostra só os campos vazios e a conversa com quem falou', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead({ preenchidos: [[1, 'já tem']] }) });
  const p = montarPedido(cands, CONVERSA);
  assert.ok(!p.includes('«✎ Queixa»'));
  assert.ok(p.includes('«⚑ Origem» — quando o paciente disser ⚑ Origem Opções: Indicação | Instagram.'));
  assert.ok(p.includes('PACIENTE: Tenho uma dor forte'));
  assert.ok(p.includes('EQUIPE DA CLÍNICA: Boa tarde!'));
});

// ─── a leitura de um cartão ───────────────────────────────────────────────────────────────────────

test('LIGADA: grava o campo vazio com a frase do paciente, deixa uma nota e não mexe em mais nada', async () => {
  const m = mundo();
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'leu');
  assert.deepEqual(m.escritas, [{ campo: 1, valor: [{ value: 'Dor forte na lombar há 3 meses, desce para a perna' }] }]);
  assert.equal(m.notas.length, 1);
  assert.match(m.notas[0], /Nada foi sobrescrito/);
  assert.equal(m.simulacoes.length, 0);
});

test('SECO: lê e decide, mas NÃO escreve no Kommo — vai para a tela como "gravaria campo X = Y"', async () => {
  const m = mundo({ estado: 'seco' });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'leu');
  assert.equal(m.escritas.length, 0);
  assert.equal(m.notas.length, 0);
  assert.equal(m.leituras.lead, 1, 'em seco nem relê o cartão para escrever');
  assert.equal(m.perguntas.length, 1, 'a leitura da IA roda em seco');
  assert.deepEqual(m.simulacoes.map((s) => [s.acao, s.alvo, s.valor]), [['gravaria', '✎ Queixa', 'Dor forte na lombar há 3 meses, desce para a perna']]);
  assert.match(m.simulacoes[0].motivo ?? '', /paciente: «dor forte na lombar/);
});

test('SECO: o que a IA sugeriu sem prova aparece como "pularia" com o motivo', async () => {
  const m = mundo({ estado: 'seco', resposta: JSON.stringify({ campos: [{ campo: '⚑ Origem', valor: 'Instagram', trecho: 'vi no instagram' }] }) });
  await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(m.escritas.length, 0);
  assert.equal(m.simulacoes[0].acao, 'pularia');
  assert.equal(m.simulacoes[0].alvo, '⚑ Origem');
});

test('NUNCA sobrescreve: se a SDR preencheu o campo enquanto a IA lia, o cartão relido manda e nada é gravado', async () => {
  const m = mundo({ relido: () => lead({ preenchidos: [[1, 'a SDR escreveu isto']] }) });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'leu');
  assert.equal(m.escritas.length, 0);
  assert.equal(r.tipo === 'leu' ? r.recusadas[0].motivo.includes('já tinha valor') : false, true);
  assert.equal(m.notas.length, 0);
});

test('se o cartão foi para o TRATAMENTO enquanto a IA lia, nada é gravado', async () => {
  const m = mundo({ relido: () => lead({ pipeline_id: TRATAMENTO }) });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.equal(m.escritas.length, 0);
});

test('se a chave foi desligada enquanto a IA lia, nada é gravado', async () => {
  const m = mundo();
  m.deps.perguntar = async () => {
    m.estado.v = 'desligado';
    return { texto: m.resposta.texto as string, custoUsd: 0 };
  };
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.equal(m.escritas.length, 0);
});

test('chave DESLIGADA: não faz nada (nem lê o cartão)', async () => {
  const m = mundo({ estado: 'desligado' });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'desligada');
  assert.equal(m.leituras.lead, 0);
  assert.equal(m.perguntas.length, 0);
});

for (const [nome, cartao, motivo] of [
  ['funil TRATAMENTO', lead({ pipeline_id: TRATAMENTO }), /TRATAMENTO/],
  ['cartão fechado', lead({ status_id: 143 }), /fechado/],
  ['currículo', lead({ _embedded: { tags: [{ id: 1, name: 'CURRÍCULO' }], contacts: [{ id: 5, is_main: true }] } }), /currículo/],
] as const) {
  test(`nunca para ${nome}: não lê a conversa, não chama a IA, não grava`, async () => {
    const m = mundo({ lead: cartao });
    const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
    assert.equal(r.tipo, 'pulou');
    assert.match(r.tipo === 'pulou' ? r.motivo : '', motivo);
    assert.equal(m.leituras.conversa, 0);
    assert.equal(m.perguntas.length, 0);
    assert.equal(m.escritas.length, 0);
  });
}

test('nunca para número interno (NUMEROS_INTERNOS): não lê a conversa nem chama a IA', async () => {
  const m = mundo();
  m.deps.kommo = () => ({ getLead: async () => lead(), getContactPhone: async () => '5524999990001', gravarCamposDoLead: async () => undefined, addLeadNote: async () => null });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.match(r.tipo === 'pulou' ? r.motivo : '', /número interno/);
  assert.equal(m.perguntas.length, 0);
});

test('sem o telefone do contato e com a lista de internos preenchida: na dúvida, não lê', async () => {
  const m = mundo();
  m.deps.kommo = () => ({ getLead: async () => lead(), getContactPhone: async () => null, gravarCamposDoLead: async () => undefined, addLeadNote: async () => null });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.equal(m.perguntas.length, 0);
});

test('a etapa não pede nenhum campo vazio: nem lê a conversa (não gasta nada)', async () => {
  const m = mundo({ lead: lead({ status_id: ESPERA }) });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.equal(m.leituras.conversa, 0);
  assert.equal(m.perguntas.length, 0);
});

test('conversa sem nenhuma fala do paciente: não chama a IA', async () => {
  const m = mundo({ falas: [fala('equipe', 'Oi, tudo bem?'), fala('sofia', 'Olá!')] });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.equal(m.perguntas.length, 0);
});

test('IA fora do ar ou resposta ilegível: nada é gravado', async () => {
  for (const resposta of [null, 'desculpe, não consegui']) {
    _limparCapturaParaTeste();
    const m = mundo({ resposta });
    const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
    assert.equal(r.tipo, 'pulou');
    assert.equal(m.escritas.length, 0);
  }
});

test('teto por cartão por dia: a leitura além do teto não chega à IA', async () => {
  const m = mundo({ resposta: JSON.stringify({ campos: [] }) });
  for (let i = 0; i < MAX_LEITURAS_POR_CARTAO_DIA; i++) {
    // conversa nova a cada volta (senão a "mesma conversa" para antes do teto)
    m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: `m${i}`, audios: new Map<string, string>() });
    const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
    assert.equal(r.tipo, 'leu');
  }
  m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: 'nova', audios: new Map<string, string>() });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.match(r.tipo === 'pulou' ? r.motivo : '', /teto do cartão/);
  assert.equal(m.perguntas.length, MAX_LEITURAS_POR_CARTAO_DIA);
});

test('o teto vale por cartão: outro cartão da mesma unidade ainda lê', async () => {
  const m = mundo({ resposta: JSON.stringify({ campos: [] }) });
  for (let i = 0; i < MAX_LEITURAS_POR_CARTAO_DIA; i++) {
    m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: `m${i}`, audios: new Map<string, string>() });
    await lerCartaoEmSilencio(UNIT, 777, m.deps);
  }
  const outro = await lerCartaoEmSilencio(UNIT, 888, m.deps);
  assert.equal(outro.tipo, 'leu');
});

test('o teto zera no dia seguinte', async () => {
  const m = mundo({ resposta: JSON.stringify({ campos: [] }) });
  for (let i = 0; i < MAX_LEITURAS_POR_CARTAO_DIA; i++) {
    m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: `m${i}`, audios: new Map<string, string>() });
    await lerCartaoEmSilencio(UNIT, 777, m.deps);
  }
  m.deps.agora = () => new Date(AGORA.getTime() + 24 * 3600_000);
  m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: 'amanha', audios: new Map<string, string>() });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'leu');
});

test('a mesma conversa com o mesmo pedido não é paga duas vezes', async () => {
  const m = mundo({ resposta: JSON.stringify({ campos: [] }) });
  await lerCartaoEmSilencio(UNIT, 777, m.deps);
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.match(r.tipo === 'pulou' ? r.motivo : '', /não mudou/);
  assert.equal(m.perguntas.length, 1);
});

test('conversa ainda quente (alguém falou há 2 min): adia em vez de ler; passado o adiamento, lê', async () => {
  const quente = [...CONVERSA, fala('equipe', 'Posso te ligar?', 2)];
  const m = mundo({ falas: quente });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps, { esperarEsfriar: true });
  assert.equal(r.tipo, 'adiada');
  assert.equal(m.perguntas.length, 0);
  const sem = await lerCartaoEmSilencio(UNIT, 777, m.deps, { esperarEsfriar: false });
  assert.equal(sem.tipo, 'leu');
});

// ─── o agendador ──────────────────────────────────────────────────────────────────────────────────

const esperar = () => new Promise((r) => setImmediate(r));

test('debounce: só lê depois dos ~10 min sem fala nova, e UMA vez mesmo com várias falas', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const m = mundo();
  for (let i = 0; i < 4; i++) {
    assert.equal(agendarCapturaSilenciosa({ unit: UNIT, leadId: 777, isChatMessage: true }, m.deps), 'agendada');
    mock.timers.tick(DEBOUNCE_MS - 60_000); // chega perto e uma fala nova recomeça a contagem
  }
  assert.equal(m.perguntas.length, 0);
  assert.equal(agendadosDaCaptura(), 1);
  mock.timers.tick(60_000);
  await esperar();
  await esperar();
  await esperar();
  assert.equal(agendadosDaCaptura(), 0);
  assert.equal(m.perguntas.length, 1);
});

test('chave desligada: o turno pulado nem agenda', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const m = mundo({ estado: 'desligado' });
  assert.equal(agendarCapturaSilenciosa({ unit: UNIT, leadId: 777, isChatMessage: true }, m.deps), 'desligada');
  assert.equal(agendadosDaCaptura(), 0);
});

test('evento que não é mensagem do paciente (campo/etapa) ou lead inválido não agenda', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const m = mundo();
  assert.equal(agendarCapturaSilenciosa({ unit: UNIT, leadId: 777, isChatMessage: false }, m.deps), 'ignorada');
  assert.equal(agendarCapturaSilenciosa({ unit: UNIT, leadId: 0, isChatMessage: true }, m.deps), 'ignorada');
  assert.equal(agendadosDaCaptura(), 0);
});

test('em seco o agendador agenda e a leitura não escreve', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const m = mundo({ estado: 'seco' });
  assert.equal(agendarCapturaSilenciosa({ unit: UNIT, leadId: 777, isChatMessage: true }, m.deps), 'agendada');
  mock.timers.tick(DEBOUNCE_MS);
  for (let i = 0; i < 5; i++) await esperar();
  assert.equal(m.perguntas.length, 1);
  assert.equal(m.escritas.length, 0);
  assert.equal(m.simulacoes[0].acao, 'gravaria');
});

test('o paciente só disse «oi»: nem chama a IA nem gasta a vaga do dia do cartão', async () => {
  const m = mundo({ falas: [fala('paciente', 'Oi'), fala('equipe', 'Olá, tudo bem? Como posso ajudar?'), fala('paciente', 'bom dia')] });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.match(r.tipo === 'pulou' ? r.motivo : '', /cumprimento/);
  assert.equal(m.perguntas.length, 0);
  // a vaga continua inteira: depois da queixa, o cartão ainda lê MAX vezes
  m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: 'depois', audios: new Map<string, string>() });
  m.resposta.texto = JSON.stringify({ campos: [] });
  assert.equal((await lerCartaoEmSilencio(UNIT, 777, m.deps)).tipo, 'leu');
});

test('IA fora do ar: a falha de UM cartão não põe a unidade em recuo; 2 cartões diferentes seguidos, sim', async () => {
  const m = mundo({ resposta: null });
  const conversa = (id: string) => (m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: id, audios: new Map<string, string>() }));
  conversa('a');
  const r1 = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.match(r1.tipo === 'pulou' ? r1.motivo : '', /IA não respondeu.*sem recuo ainda/);
  conversa('a2');
  await lerCartaoEmSilencio(UNIT, 777, m.deps); // o MESMO cartão de novo: continua sem recuo
  assert.equal(m.perguntas.length, 2);
  conversa('b');
  await lerCartaoEmSilencio(UNIT, 888, m.deps); // um 2º cartão diferente falha: agora a unidade recua
  assert.equal(m.perguntas.length, 3);
  conversa('c');
  const r4 = await lerCartaoEmSilencio(UNIT, 999, m.deps);
  assert.match(r4.tipo === 'pulou' ? r4.motivo : '', /recuo/);
  assert.equal(m.perguntas.length, 3);
  // passado o recuo (5 min), tenta de novo
  m.deps.agora = () => new Date(AGORA.getTime() + 6 * 60_000);
  await lerCartaoEmSilencio(UNIT, 999, m.deps);
  assert.equal(m.perguntas.length, 4);
  // e nenhuma dessas vezes gastou a vaga do dia: com a IA de volta, o cartão ainda lê
  m.resposta.texto = JSON.stringify({ campos: [] });
  m.deps.agora = () => new Date(AGORA.getTime() + 90 * 60_000);
  assert.equal((await lerCartaoEmSilencio(UNIT, 777, m.deps)).tipo, 'leu');
});

test('o teto usa o dia LOCAL de cada unidade: a virada de uma não zera o placar da outra', async () => {
  // 15:00Z de 16/11: em Brasília ainda é dia 16 (12:00); em Tóquio já é 17 (00:00)
  const TOQUIO = { id: 'u-toq', slug: 'toquio', spineTimezone: 'Asia/Tokyo' } as unknown as Unit;
  const m = mundo({ resposta: JSON.stringify({ campos: [] }) });
  const conversa = (id: string) => (m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: id, audios: new Map<string, string>() }));
  for (let i = 0; i < MAX_LEITURAS_POR_CARTAO_DIA; i++) {
    conversa(`p${i}`);
    assert.equal((await lerCartaoEmSilencio(UNIT, 777, m.deps)).tipo, 'leu');
    conversa(`t${i}`); // a cada leitura de Petrópolis, uma de Tóquio no meio (o «dia» de Tóquio é outro)
    await lerCartaoEmSilencio(TOQUIO, 5, m.deps);
  }
  conversa('p-extra');
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou', 'o placar de Petrópolis sobreviveu às leituras de Tóquio');
  assert.match(r.tipo === 'pulou' ? r.motivo : '', /teto do cartão/);
  assert.equal(m.perguntas.length, MAX_LEITURAS_POR_CARTAO_DIA * 2);
});

test('Kommo dividido: se o cartão trocou de unidade enquanto a IA lia, nada é gravado', async () => {
  const campoUnidade = (v: string) => ({ field_id: 99, field_name: '⌂ Unidade de atendimento', values: [{ value: v }] });
  const grupo = { contaUnitId: 'u-pet', membros: [{ unitId: 'u-pet', contaUnitId: 'u-pet', rotulo: 'Petrópolis' }, { unitId: 'u-cax', contaUnitId: 'u-pet', rotulo: 'Caxias' }] };
  const m = mundo({ lead: lead({ custom_fields_values: [campoUnidade('Petrópolis')] as never }), relido: () => lead({ custom_fields_values: [campoUnidade('Caxias')] as never }) });
  m.deps.grupo = async () => grupo;
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.match(r.tipo === 'pulou' ? r.motivo : '', /Kommo dividido.*ao reler/);
  assert.equal(m.escritas.length, 0);
  // e o cartão que continua sendo desta unidade grava normalmente
  _limparCapturaParaTeste();
  const ok = mundo({ lead: lead({ custom_fields_values: [campoUnidade('Petrópolis')] as never }) });
  ok.deps.grupo = async () => grupo;
  assert.equal((await lerCartaoEmSilencio(UNIT, 777, ok.deps)).tipo, 'leu');
  assert.equal(ok.escritas.length, 1);
});

test('onde o preenche-campos está ligado, a Qualificação NÃO é pedida nem gravada (ele espera 6 h de propósito)', async () => {
  const resposta = JSON.stringify({ campos: [{ campo: '★ Qualificação (Quente/Morno/Frio)', valor: 'Quente', trecho: '' }, { campo: '✎ Observações', valor: 'Paciente quer marcar logo, veio por indicação', trecho: '' }] });
  const m = mundo({ resposta });
  m.robo.v = true;
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'leu');
  assert.ok(!m.perguntas[0].includes('Qualificação'), 'a IA nem recebe o campo');
  assert.deepEqual(m.escritas.map((e) => e.campo), [8], 'só as Observações (id 8); nada da Qualificação (id 2)');
  assert.equal(m.lotes.n, 1);
  // sem o robô, a Qualificação volta a ser candidata
  _limparCapturaParaTeste();
  const livre = mundo({ resposta });
  await lerCartaoEmSilencio(UNIT, 777, livre.deps);
  assert.deepEqual(livre.escritas.map((e) => e.campo).sort(), [2, 8]);
  assert.equal(livre.lotes.n, 1, 'os dois campos num PATCH só');
});

test('áudio sem transcrição: tenta nos turnos seguintes sem pagar a IA; na tentativa MAX do dia lê SEM o áudio, com a lacuna dita à IA e marcada', async () => {
  const m = mundo({ resposta: JSON.stringify({ campos: [] }) });
  m.transcricoes.faltam = 1;
  for (let i = 1; i < MAX_TENTATIVAS_DE_AUDIO; i++) {
    const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
    assert.equal(r.tipo, 'pulou');
    assert.match(r.tipo === 'pulou' ? r.motivo : '', new RegExp(`tentativa ${i} de ${MAX_TENTATIVAS_DE_AUDIO}`));
  }
  assert.equal(m.perguntas.length, 0, 'enquanto há tentativa, não paga a IA para ler a conversa pela metade');
  const ultima = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(ultima.tipo, 'leu', 'o cartão não fica sem leitura para sempre');
  assert.equal(ultima.tipo === 'leu' ? ultima.audiosSemTexto : -1, 1);
  assert.match(m.perguntas[0], /1 áudio\(s\) do paciente .* não puderam ser ouvidos/);
  assert.equal((await lerCartaoEmSilencio(UNIT, 777, m.deps)).tipo, 'pulou', 'lida (com a lacuna): não relê a mesma conversa');
});

test('áudio sem transcrição lido sem ele: a lacuna aparece no «gravaria» da tela e na nota do cartão', async () => {
  for (const estado of ['seco', 'ligado'] as const) {
    _limparCapturaParaTeste();
    const m = mundo({ estado });
    m.transcricoes.faltam = 1;
    for (let i = 0; i < MAX_TENTATIVAS_DE_AUDIO; i++) await lerCartaoEmSilencio(UNIT, 777, m.deps);
    if (estado === 'seco') assert.match(String(m.simulacoes[0].motivo), /1 áudio\(s\) do paciente sem transcrição/);
    else assert.match(m.notas[0], /1 áudio\(s\) do paciente não foram ouvidos/);
  }
});

const RESPOSTA_QUEIXA_E_ORIGEM = JSON.stringify({
  campos: [
    { campo: '✎ Queixa', valor: 'Dor forte na lombar há 3 meses', trecho: 'dor forte na lombar há 3 meses' },
    { campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' },
  ],
});
const kommoQueRecusa = (m: Mundo, erro: () => Error, chamadas: Array<number[]>) => {
  const original = m.deps.kommo(UNIT);
  m.deps.kommo = () => ({
    ...original,
    gravarCamposDoLead: async (l: number, campos: Array<{ field_id: number; values: unknown }>) => {
      chamadas.push(campos.map((c) => c.field_id));
      if (campos.length > 1 || campos.some((c) => c.field_id === 5)) throw erro(); // o lote inteiro e o campo ruim (Origem, id 5)
      return original.gravarCamposDoLead(l, campos as never);
    },
  });
};

test('HTTP 400 no lote (valor ruim): relê o cartão e cai para campo a campo — o campo ruim não bloqueia o bom', async () => {
  const m = mundo({ resposta: RESPOSTA_QUEIXA_E_ORIGEM });
  const chamadas: number[][] = [];
  kommoQueRecusa(m, () => new KommoApiError('x', 400, {}), chamadas);
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.deepEqual(chamadas, [[1, 5], [1], [5]]);
  assert.equal(r.tipo === 'leu' ? r.gravou.map((g) => g.campo).join() : '', '✎ Queixa');
  assert.equal(r.tipo === 'leu' ? r.recusadas.some((x) => x.campo === '⚑ Origem' && /Kommo recusou/.test(x.motivo)) : false, true);
  assert.equal(m.leituras.lead, 3, 'cartão lido 1x + reconferido antes do lote + reconferido antes da volta campo a campo');
});

test('a SDR preenche a Queixa enquanto o lote cai: a volta campo a campo NÃO cobre o que ela escreveu', async () => {
  let m!: Mundo;
  // 1ª leitura: vazio; 2ª (antes do lote): vazio; 3ª (antes da volta campo a campo): a SDR já escreveu a Queixa
  m = mundo({ resposta: RESPOSTA_QUEIXA_E_ORIGEM, relido: () => (m.leituras.lead >= 3 ? lead({ preenchidos: [[1, 'a SDR escreveu isto']] }) : lead()) });
  const chamadas: number[][] = [];
  kommoQueRecusa(m, () => new KommoApiError('x', 400, {}), chamadas);
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.deepEqual(chamadas, [[1, 5], [5]], 'a Queixa não vai sozinha: o cartão relido já a tinha');
  assert.equal(m.escritas.length, 0, 'nada foi escrito por cima');
  assert.equal(r.tipo === 'leu' ? r.recusadas.some((x) => x.campo === '✎ Queixa' && /não sobrescrevi/.test(x.motivo)) : false, true);
});

test('lote recusado por 429, 403, timeout ou rede: só registra e sai — sem reler, sem campo a campo, sem marcar como lido', async () => {
  for (const erro of [() => new KommoApiError('x', 429, {}), () => new KommoApiError('x', 403, {}), () => new KommoApiError('x', undefined, {}), () => new Error('ETIMEDOUT')]) {
    _limparCapturaParaTeste();
    const m = mundo({ resposta: RESPOSTA_QUEIXA_E_ORIGEM });
    const chamadas: number[][] = [];
    kommoQueRecusa(m, erro, chamadas);
    const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
    assert.deepEqual(chamadas, [[1, 5]], 'um PATCH só: nada de insistir campo a campo');
    assert.equal(m.leituras.lead, 2, 'sem a releitura da volta campo a campo');
    assert.equal(r.tipo === 'leu' ? r.gravou.length : -1, 0);
    // não marcou como lida: o próximo turno tenta de novo
    const de_novo = await lerCartaoEmSilencio(UNIT, 777, m.deps);
    assert.equal(de_novo.tipo, 'leu');
  }
});

test('campo a campo: se um campo falha com 429, os que faltam não são tentados', async () => {
  const resposta = JSON.stringify({
    campos: [
      { campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' },
      { campo: '✎ Queixa', valor: 'Dor forte na lombar há 3 meses', trecho: 'dor forte na lombar há 3 meses' },
      { campo: '★ Qualificação (Quente/Morno/Frio)', valor: 'Quente', trecho: '' },
    ],
  });
  const m = mundo({ resposta });
  const original = m.deps.kommo(UNIT);
  const chamadas: number[][] = [];
  m.deps.kommo = () => ({
    ...original,
    gravarCamposDoLead: async (_l: number, campos: Array<{ field_id: number; values: unknown }>) => {
      chamadas.push(campos.map((c) => c.field_id));
      if (campos.length > 1) throw new KommoApiError('x', 400, {});
      if (campos[0].field_id === 5) throw new KommoApiError('x', 429, {}); // o 1º campo da volta leva 429
    },
  });
  await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(chamadas.length, 2, 'o lote + um único campo; os outros dois não foram tentados');
});

test('chamada à IA que LANÇA conta como IA fora do ar: 2 cartões diferentes armam o recuo da unidade', async () => {
  const m = mundo();
  m.deps.perguntar = async () => {
    throw new Error('ECONNRESET');
  };
  const r1 = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.match(r1.tipo === 'pulou' ? r1.motivo : '', /IA não respondeu/);
  m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: 'outra', audios: new Map<string, string>() });
  await lerCartaoEmSilencio(UNIT, 888, m.deps);
  const r3 = await lerCartaoEmSilencio(UNIT, 999, m.deps);
  assert.match(r3.tipo === 'pulou' ? r3.motivo : '', /recuo/);
});

test('validar: a lista sem conteúdo vale pela palavra INTEIRA — "interesse" não libera "intermitente"/"internação", "conversa" não libera "convênio"', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  for (const palavra of ['intermitente', 'internação', 'convênio']) {
    const r = validarSugestoes([{ campo: '✎ Queixa', valor: `Dor na lombar ${palavra}`, trecho: 'dor forte na lombar há 3 meses' }], cands, CONVERSA);
    assert.equal(r.aceitas.length, 0, palavra);
    assert.match(r.recusadas[0].motivo, new RegExp(`detalhe que o paciente não disse \\(.*${palavra.normalize('NFD').replace(/[\u0300-\u036f]/g, '')}`), palavra);
  }
  // as palavras da própria lista continuam isentas, inteiras
  assert.deepEqual(palavrasForaDaFala('Paciente com interesse na conversa sobre dor na lombar', 'dor forte na lombar'), []);
  assert.deepEqual(palavrasForaDaFala('interesse intermitente internacao conversa convenio', 'nada disso'), ['intermitente', 'internacao', 'convenio']);
});

test('validar: frase de prova sobre OUTRA pessoa não prova Região da dor nem Queixa (caso real 5806575)', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const conversa = [fala('paciente', 'Bom dia, o pessoal ainda não respondeu se o tratamento para o meu pai será eficaz'), fala('paciente', 'Meu pai tem dor na lombar irradiando para a perna')];
  const r = validarSugestoes(
    [
      { campo: '⚕ Região da dor', valor: 'Lombar', trecho: 'Meu pai tem dor na lombar irradiando para a perna' },
      { campo: '✎ Queixa', valor: 'Dor na lombar irradiando para a perna', trecho: 'Meu pai tem dor na lombar irradiando para a perna' },
    ],
    cands,
    conversa,
  );
  assert.equal(r.aceitas.length, 0);
  assert.ok(r.recusadas.every((x) => /fala de outra pessoa/.test(x.motivo)));
  assert.equal(r.recusadas.length, 2);
  // a mesma dor dita por quem escreve passa
  const propria = validarSugestoes([{ campo: '⚕ Região da dor', valor: 'Lombar', trecho: 'sinto dor na lombar há tempos' }], cands, [...CONVERSA, fala('paciente', 'sinto dor na lombar há tempos')]);
  assert.equal(propria.aceitas.length, 1);
  assert.ok(falaDeOutraPessoa('minha mãe também sente') && falaDeOutraPessoa('o marido dela') && !falaDeOutraPessoa('sinto dor na lombar'));
});

test('o que o PACIENTE escreveu vale por radical de 6 letras: «interesse» não libera «intermitente»/«internação», «conversar» não libera «convênio»', () => {
  const dito = 'Tenho interesse e quero conversar, sinto dores lombares e dor na perna';
  assert.deepEqual(palavrasForaDaFala('Dor intermitente', dito), ['intermitente']);
  assert.deepEqual(palavrasForaDaFala('Dor com internação', dito), ['internacao']);
  assert.deepEqual(palavrasForaDaFala('Dor sem convênio', dito), ['convenio']);
  // pelo radical de 5 letras (a regra anterior) as três passariam
  assert.equal(chaveDaPalavra('interesse'), 'intere');
  assert.notEqual(chaveDaPalavra('interesse'), chaveDaPalavra('intermitente'));
  assert.notEqual(chaveDaPalavra('interesse'), chaveDaPalavra('internacao'));
  assert.notEqual(chaveDaPalavra('conversar'), chaveDaPalavra('convenio'));
});

test('plural e flexão simples seguem passando: «dores»/«dor», «lombar»/«lombares», «pernas»/«perna», «internações»/«internação»', () => {
  assert.deepEqual(palavrasForaDaFala('Dores lombares', 'dor lombar'), []);
  assert.deepEqual(palavrasForaDaFala('Dor lombar', 'dores lombares'), []);
  assert.deepEqual(palavrasForaDaFala('Dor nas pernas', 'sinto dor na perna'), []);
  assert.deepEqual(palavrasForaDaFala('Dor na perna', 'dói nas pernas'), []);
  assert.deepEqual(palavrasForaDaFala('Duas internações', 'fui internado, tive uma internação'), []);
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const r = validarSugestoes([{ campo: '✎ Queixa', valor: 'Dores lombares', trecho: 'sinto dor na lombar' }], cands, [...CONVERSA, fala('paciente', 'sinto dor na lombar')]);
  assert.equal(r.aceitas.length, 1);
});

test('outra pessoa: esposo, noivo(a), namorado(a), enteado(a), neto(a), sobrinho(a), bisavô/bisavó também contam', () => {
  for (const f of ['meu esposo sente dor', 'minha noiva está mal', 'meu noivo tem dor', 'minha namorada reclama', 'meu enteado sente dor', 'minha enteada', 'minha neta tem dor', 'meu neto', 'meu sobrinho', 'minha sobrinha sente', 'meu bisavô tem dor', 'minha bisavó caiu']) {
    assert.equal(falaDeOutraPessoa(f), true, f);
  }
  assert.equal(falaDeOutraPessoa('sinto dor na lombar'), false);
});

test('outra pessoa: «ele/ela» sem parente na frase, mas com parente numa das 3 falas anteriores do paciente, também é outra pessoa', () => {
  const falas = ['Boa tarde, meu pai está com dor há tempos', 'Ele já fez exame', 'Quero saber o valor', 'Ele tem dor na lombar irradiando'].map((t) => fala('paciente', t));
  assert.equal(falaDeOutraPessoaNoContexto('Ele tem dor na lombar irradiando', falas), true);
  // o parente está a 4 falas de distância: não conta
  const longe = ['meu marido está mal', 'a', 'b', 'c', 'Ela sente dor na lombar'].map((t) => fala('paciente', t));
  assert.equal(falaDeOutraPessoaNoContexto('Ela sente dor na lombar', longe), false);
  // parente e «ela» na MESMA mensagem (o jeito mais comum; sênior, 16/11): a IA cita só «Ela tem dor na lombar»
  const mesma = ['Boa tarde', 'É pra minha mãe. Ela tem dor na lombar há meses'].map((t) => fala('paciente', t));
  assert.equal(falaDeOutraPessoaNoContexto('Ela tem dor na lombar', mesma), true);
  // sem pronome de terceiro, a dor é de quem escreve
  const propria = ['meu pai está com dor', 'Eu tenho dor na lombar'].map((t) => fala('paciente', t));
  assert.equal(falaDeOutraPessoaNoContexto('Eu tenho dor na lombar', propria), false);
  // e no validador: a Região da dor e a Queixa com essa frase de prova são recusadas
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const r = validarSugestoes(
    [
      { campo: '⚕ Região da dor', valor: 'Lombar', trecho: 'Ele tem dor na lombar irradiando' },
      { campo: '✎ Queixa', valor: 'Dor na lombar irradiando', trecho: 'Ele tem dor na lombar irradiando' },
    ],
    cands,
    [...CONVERSA.slice(0, 1), ...falas],
  );
  assert.equal(r.aceitas.length, 0);
  assert.equal(r.recusadas.filter((x) => /fala de outra pessoa/.test(x.motivo)).length, 2);
});

test('valor que o Kommo recusa com 400 marca a conversa como lida: o próximo turno não paga a IA de novo', async () => {
  const resposta = JSON.stringify({ campos: [{ campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' }] });
  const m = mundo({ resposta });
  kommoQueRecusa(m, () => new KommoApiError('x', 400, {}), []);
  const r1 = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r1.tipo === 'leu' ? r1.gravou.length : -1, 0);
  const r2 = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r2.tipo, 'pulou');
  assert.match(r2.tipo === 'pulou' ? r2.motivo : '', /não mudou/);
  assert.equal(m.perguntas.length, 1);
});

test('a contagem de tentativas de áudio zera quando a transcrição dá certo', async () => {
  const m = mundo({ resposta: JSON.stringify({ campos: [] }) });
  m.transcricoes.faltam = 1;
  await lerCartaoEmSilencio(UNIT, 777, m.deps); // tentativa 1
  await lerCartaoEmSilencio(UNIT, 777, m.deps); // tentativa 2
  m.transcricoes.faltam = 0; // o Whisper voltou
  assert.equal((await lerCartaoEmSilencio(UNIT, 777, m.deps)).tipo, 'leu');
  // conversa nova, o áudio falha de novo: recomeça em 1 (sem a zerada seria a 3ª e leria sem o áudio)
  m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: 'nova', audios: new Map<string, string>() });
  m.transcricoes.faltam = 1;
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.match(r.tipo === 'pulou' ? r.motivo : '', /tentativa 1 de/);
});

test('validar: tempo e número no valor têm de aparecer IGUAIS numa fala do paciente («há 2 anos», 3 → 8 meses)', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const conversa = [fala('paciente', 'tenho dor na lombar há 3 meses')];
  const tenta = (valor: string) => validarSugestoes([{ campo: '✎ Queixa', valor, trecho: 'dor na lombar há 3 meses' }], cands, conversa);
  const oito = tenta('Dor na lombar há 8 meses');
  assert.equal(oito.aceitas.length, 0);
  assert.match(oito.recusadas[0].motivo, /número ou tempo.*\(8\)/);
  assert.match(tenta('Dor na lombar há 2 anos').recusadas[0].motivo, /número ou tempo.*\(2\)/);
  assert.equal(tenta('Dor na lombar há 3 meses').aceitas.length, 1);
  assert.equal(tenta('Dor na lombar há três meses').aceitas.length, 1, 'por extenso conta como o mesmo número');
  // «um ano» (por extenso) e «1 ano» são o mesmo; o artigo «um» sozinho não vira o número 1
  assert.deepEqual([...numerosDoTexto('faz um ano e dois meses, tenho um problema')].sort(), [1, 2]);
});

test('validar: o mesmo valor repetido pela IA é eco (não vira «pularia»); um valor DIFERENTE fica registrado', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const igual = validarSugestoes(
    [
      { campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' },
      { campo: '⚑ Origem', valor: 'indicação', trecho: 'indicação de uma amiga' },
    ],
    cands,
    CONVERSA,
  );
  assert.equal(igual.aceitas.length, 1);
  assert.equal(igual.recusadas.length, 0);
  const diferente = validarSugestoes(
    [
      { campo: '⚑ Origem', valor: 'Indicação', trecho: 'indicação de uma amiga' },
      { campo: '⚑ Origem', valor: 'Instagram', trecho: 'indicação de uma amiga' },
    ],
    cands,
    CONVERSA,
  );
  assert.equal(diferente.aceitas.length, 1);
  assert.match(diferente.recusadas[0].motivo, /dois valores diferentes/);
});

test('o que o SECO leu não impede a primeira leitura de verdade quando a chave é ligada', async () => {
  const m = mundo({ estado: 'seco' });
  assert.equal((await lerCartaoEmSilencio(UNIT, 777, m.deps)).tipo, 'leu');
  assert.equal(m.escritas.length, 0);
  m.estado.v = 'ligado';
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'leu');
  assert.equal(m.escritas.length, 1);
});

test('falha ao gravar no Kommo não marca a conversa como lida: o próximo turno tenta de novo', async () => {
  const m = mundo();
  const original = m.deps.kommo(UNIT);
  let falhar = true;
  m.deps.kommo = () => ({ ...original, gravarCamposDoLead: async (...a: Parameters<typeof original.gravarCamposDoLead>) => (falhar ? Promise.reject(new Error('Kommo 500')) : original.gravarCamposDoLead(...a)) });
  const r1 = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r1.tipo === 'leu' ? r1.gravou.length : -1, 0);
  falhar = false;
  const r2 = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r2.tipo === 'leu' ? r2.gravou.length : -1, 1);
});

test('áudio só é transcrito depois dos portões baratos: conversa adiada ou sem mudança não paga Whisper', async () => {
  const quente = [...CONVERSA, fala('paciente', 'mandei um áudio agora', 2, 'voice')];
  const m = mundo({ falas: quente });
  assert.equal((await lerCartaoEmSilencio(UNIT, 777, m.deps, { esperarEsfriar: true })).tipo, 'adiada');
  assert.equal(m.transcricoes.n, 0);
  const frio = mundo({ falas: CONVERSA, resposta: JSON.stringify({ campos: [] }) });
  await lerCartaoEmSilencio(UNIT, 777, frio.deps);
  assert.equal(frio.transcricoes.n, 1);
  const outra = await lerCartaoEmSilencio(UNIT, 777, frio.deps);
  assert.equal(outra.tipo, 'pulou');
  assert.equal(frio.transcricoes.n, 1, 'a mesma conversa não transcreve de novo');
});

test('validar: cidade/estado/profissão só valem se o valor está ESCRITO numa fala do paciente', () => {
  const regras = [...REGRAS, regra('registra_cidade', 3, '⌂ Cidade', 'textarea')];
  const defs = DEFS.map((d) => (d.id === 3 ? { ...d, hidden_statuses: [] } : d));
  const cands = camposDaEtapaVazios({ regras, defs, lead: lead() });
  const conversa = [...CONVERSA, fala('paciente', 'moro em Itaipava, aqui perto de Petrópolis')];
  const inventada = validarSugestoes([{ campo: '⌂ Cidade', valor: 'Teresópolis', trecho: 'moro em Itaipava' }], cands, conversa);
  assert.equal(inventada.aceitas.length, 0);
  assert.match(inventada.recusadas[0].motivo, /não aparece escrito/);
  const certa = validarSugestoes([{ campo: '⌂ Cidade', valor: 'Petrópolis', trecho: 'aqui perto de Petrópolis' }], cands, conversa);
  assert.equal(certa.aceitas.length, 1);
});

test('validar: texto livre com frase que não tem relação com o valor é recusado ("bom dia" não prova uma queixa)', () => {
  const cands = camposDaEtapaVazios({ regras: REGRAS, defs: DEFS, lead: lead() });
  const conversa = [...CONVERSA, fala('paciente', 'bom dia, tudo bem?')];
  const r = validarSugestoes([{ campo: '✎ Queixa', valor: 'Dor lombar crônica', trecho: 'bom dia, tudo bem?' }], cands, conversa);
  assert.equal(r.aceitas.length, 0);
  assert.match(r.recusadas[0].motivo, /nenhuma palavra em comum/);
  const ok = validarSugestoes([{ campo: '✎ Queixa', valor: 'Dor lombar há 3 meses', trecho: 'dor forte na lombar há 3 meses' }], cands, conversa);
  assert.equal(ok.aceitas.length, 1);
});

test('campo de endereço (streetaddress) ou data e hora não são candidatos: o gravador não sabe escrevê-los', () => {
  const defs = DEFS.map((d) => (d.id === 1 ? { ...d, type: 'streetaddress' } : d));
  assert.ok(!camposDaEtapaVazios({ regras: REGRAS, defs, lead: lead() }).some((c) => c.def.id === 1));
});

test('uma leitura travada não prende a fila: passado o prazo, a próxima do mesmo processo anda', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const travada = mundo();
  travada.deps.perguntar = () => new Promise(() => undefined);
  const normal = mundo();
  agendarCapturaSilenciosa({ unit: UNIT, leadId: 1, isChatMessage: true }, travada.deps);
  agendarCapturaSilenciosa({ unit: UNIT, leadId: 2, isChatMessage: true }, normal.deps);
  mock.timers.tick(DEBOUNCE_MS);
  for (let i = 0; i < 10; i++) await esperar();
  assert.equal(normal.perguntas.length, 0, 'ainda presa atrás da primeira');
  mock.timers.tick(PRAZO_DA_LEITURA_MS);
  for (let i = 0; i < 10; i++) await esperar();
  assert.equal(normal.perguntas.length, 1);
});

test('o agendador guarda só a identidade da unidade, não a linha inteira (tokens)', () => {
  const src = readFileSync(new URL('./captura-silenciosa.ts', import.meta.url), 'utf8');
  assert.match(src, /const unit: UnidadeDoAgendamento = \{ id: args\.unit\.id, slug: args\.unit\.slug \}/);
});

// ─── a fiação ─────────────────────────────────────────────────────────────────────────────────────

test('o webhook agenda a captura no mesmo ponto do cadastro com a IA pulada (turno PULADO), e só ali', () => {
  const src = readFileSync(new URL('../controllers/webhook.controller.ts', import.meta.url), 'utf8');
  const bloco = src.slice(src.indexOf('export async function processAgent'), src.indexOf('export async function cadastrarQuandoIaPulada'));
  assert.match(bloco, /if \(r === TURNO_PULADO\) void cadastrarQuandoIaPulada\(args\);[\s\S]*?if \(r === TURNO_PULADO\) agendarCapturaSilenciosa\(args\);/);
  assert.equal(src.match(/agendarCapturaSilenciosa\(/g)?.length, 1);
});

test('o catálogo: chave captura-silenciosa com seco obrigatório antes, nasce desligada e a lista de slugs é a do .env', () => {
  const a = AUTOMACOES.find((x) => x.id === 'captura-silenciosa');
  assert.ok(a);
  assert.equal(a.risco, 'escreve-campo');
  assert.equal(a.temSeco, true);
  assert.equal(a.exigeSecoAntes, true);
  assert.equal(a.quandoVazio, 'desligado');
  assert.equal(a.chave, 'CAPTURA_SILENCIOSA_SLUGS');
  assert.deepEqual(verificarCatalogo(), []);
});
