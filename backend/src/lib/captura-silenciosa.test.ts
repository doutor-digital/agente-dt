/**
 * Captura silenciosa: a IA lê a conversa do cartão quando a Sofia não fala e preenche SÓ os campos vazios que a etapa pede.
 * Sem banco, sem Kommo e sem IA de verdade: as dependências são trocadas.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { LeadFieldRule, Unit } from '@prisma/client';
import type { KommoLead } from '../services/kommo.service.js';
import type { DefinicaoDeCampo } from './ponte-ligacao.js';
import type { Fala } from './cutucada-apos-equipe.js';
import type { Estado } from './automacoes-estado.js';
import {
  CAMPOS_CAPTURAVEIS,
  DEBOUNCE_MS,
  MAX_LEITURAS_POR_CARTAO_DIA,
  PRAZO_DA_LEITURA_MS,
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
  notas: string[];
  simulacoes: Array<{ acao: string; alvo: string; valor?: unknown; motivo?: string | null }>;
  perguntas: string[];
  leituras: { lead: number; conversa: number };
  transcricoes: { n: number };
  cartao: { atual: KommoLead };
  resposta: { texto: string | null };
}

function mundo(o: { lead?: KommoLead; falas?: Fala[]; estado?: Estado; resposta?: string | null; relido?: () => KommoLead } = {}): Mundo {
  const estado = { v: o.estado ?? 'ligado' };
  const cartao = { atual: o.lead ?? lead() };
  const m: Mundo = {
    estado,
    escritas: [],
    notas: [],
    simulacoes: [],
    perguntas: [],
    leituras: { lead: 0, conversa: 0 },
    transcricoes: { n: 0 },
    cartao,
    resposta: { texto: o.resposta === undefined ? JSON.stringify({ campos: [{ campo: '✎ Queixa', valor: 'Dor forte na lombar há 3 meses, desce para a perna', trecho: 'dor forte na lombar há 3 meses e desce para a perna' }] }) : o.resposta },
    deps: null as never,
  };
  m.deps = {
    agora: () => AGORA,
    unidade: async (u) => u as Unit,
    estado: () => estado.v,
    kommo: () => ({
      getLead: async () => {
        m.leituras.lead++;
        return o.relido && m.leituras.lead > 1 ? o.relido() : cartao.atual;
      },
      getContactPhone: async () => '5524988887777',
      setLeadCustomFieldValue: async (_l: number, campo: number, _t: unknown, valor: unknown) => void m.escritas.push({ campo, valor }),
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
    transcrever: async () => void m.transcricoes.n++,
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
  assert.equal(r.recusadas.length, 2);
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
  assert.deepEqual(m.escritas, [{ campo: 1, valor: 'Dor forte na lombar há 3 meses, desce para a perna' }]);
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
  m.deps.kommo = () => ({ getLead: async () => lead(), getContactPhone: async () => '5524999990001', setLeadCustomFieldValue: async () => undefined, addLeadNote: async () => null });
  const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
  assert.equal(r.tipo, 'pulou');
  assert.match(r.tipo === 'pulou' ? r.motivo : '', /número interno/);
  assert.equal(m.perguntas.length, 0);
});

test('sem o telefone do contato e com a lista de internos preenchida: na dúvida, não lê', async () => {
  const m = mundo();
  m.deps.kommo = () => ({ getLead: async () => lead(), getContactPhone: async () => null, setLeadCustomFieldValue: async () => undefined, addLeadNote: async () => null });
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

test('IA fora do ar não gasta a vaga do dia do cartão', async () => {
  const m = mundo({ resposta: null });
  for (let i = 0; i < MAX_LEITURAS_POR_CARTAO_DIA + 2; i++) {
    m.deps.falas = async () => ({ falas: CONVERSA, ultimaId: `m${i}`, audios: new Map<string, string>() });
    const r = await lerCartaoEmSilencio(UNIT, 777, m.deps);
    assert.doesNotMatch(r.tipo === 'pulou' ? r.motivo : '', /teto/);
  }
  assert.equal(m.perguntas.length, MAX_LEITURAS_POR_CARTAO_DIA + 2);
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
  m.deps.kommo = () => ({ ...original, setLeadCustomFieldValue: async (...a: Parameters<typeof original.setLeadCustomFieldValue>) => (falhar ? Promise.reject(new Error('Kommo 500')) : original.setLeadCustomFieldValue(...a)) });
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
  const ok = validarSugestoes([{ campo: '✎ Queixa', valor: 'Lombalgia há 3 meses', trecho: 'dor forte na lombar há 3 meses' }], cands, conversa);
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
