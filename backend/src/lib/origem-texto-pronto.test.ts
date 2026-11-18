/**
 * ⚑ Origem pelo texto pronto da 1ª mensagem (WhatsApp Lite de Petrópolis e Caxias, 18/11/2026).
 * Sem banco, sem Kommo: as dependências são trocadas. Cobre: normalização, casa/não casa, não reescreve, seco não grava,
 * o cadastro-todo-lead só trata a frase como anúncio com a chave LIGADA, e o prompt não vê a lista.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { _semearParaTeste } from './automacoes-estado.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { deveCriarNaFranquia } from './cadastro-na-franquia.js';
import { _limparCacheParaTeste, decidirCadastroDoLead, type DepsDoCadastro } from './cadastro-todo-lead.js';
import type { DefinicaoDeCampo } from './ponte-ligacao.js';
import type { Simulacao } from './so-no-papel.js';
import {
  CHAVE_DA_LISTA,
  MAX_FALAS_OLHADAS,
  NOME_DO_CAMPO_ORIGEM,
  _limparOrigemParaTeste,
  anuncioPelaFrase,
  aplicarOrigemPorTexto,
  casarFala,
  casarPrimeirasFalas,
  estadoDaOrigemPorTexto,
  lerListaDeTextos,
  normalizarFrase,
  planejarOrigem,
  resolverOpcao,
  type DepsDaOrigem,
  type KommoDaOrigem,
  type UnidadeDaOrigem,
} from './origem-texto-pronto.js';

const NAVEGANDO = 'Olá estava navegando e gostaria de mais informações sobre tratamento.';
const INTERESSE = 'Tenho interesse. Por favor, você poderia me passar mais informações?';
const SITE = 'Olá, tudo bem? Estava navegando no site doutorhernia.com.br e gostaria de uma informação.';

const LISTA_BRUTA = [
  { texto: NAVEGANDO, origem: 'WhatsApp anúncio', anuncio: true },
  { texto: INTERESSE, origem: 'WhatsApp anúncio', anuncio: true },
  { texto: SITE, origem: 'Site oficial - Franquia', anuncio: true },
  { texto: 'Olá! Posso ter mais informações sobre isso? (frase de teste fora do anúncio)', origem: 'Indicação', anuncio: false },
];

const PET: UnidadeDaOrigem = { id: 'u-pet', slug: 'doutor-hernia-petropolis', pipelineIntents: { scheduled_meeting: 123, [CHAVE_DA_LISTA]: LISTA_BRUTA } } as unknown as UnidadeDaOrigem;
const CAMPO_ORIGEM = 210362;
const ENUM_WA = 285914;
const DEFS: DefinicaoDeCampo[] = [
  { id: 1, name: '✎ Queixa', type: 'text', enums: [] },
  {
    id: CAMPO_ORIGEM,
    name: NOME_DO_CAMPO_ORIGEM,
    type: 'select',
    enums: [
      { id: ENUM_WA, value: 'WhatsApp anúncio' },
      { id: 285915, value: 'Site oficial - Franquia' },
      { id: 285916, value: 'Indicação' },
    ],
  },
];

const cartao = (origemEnum?: number) => ({
  id: 777,
  status_id: 10,
  pipeline_id: 1,
  custom_fields_values: origemEnum ? [{ field_id: CAMPO_ORIGEM, values: [{ enum_id: origemEnum, value: 'x' }] }] : [],
});

interface Registro {
  getLead: number;
  gravou: Array<{ leadId: number; campos: unknown }>;
  notas: string[];
  simulacoes: Simulacao[];
  leituras: number;
}

function montar(o: { estado?: 'ligado' | 'seco' | 'desligado'; falas?: string[]; lead?: ReturnType<typeof cartao>; defs?: DefinicaoDeCampo[]; kommoFalha?: boolean; grupoOutraUnidade?: boolean } = {}) {
  const r: Registro = { getLead: 0, gravou: [], notas: [], simulacoes: [], leituras: 0 };
  const kommo = {
    async getLead() {
      r.getLead++;
      if (o.kommoFalha) throw new Error('429');
      return o.lead ?? cartao();
    },
    async listarCamposDoCartao() {
      return o.defs ?? DEFS;
    },
    async gravarCamposDoLead(leadId: number, campos: unknown) {
      r.gravou.push({ leadId, campos });
    },
    async addLeadNote(_id: number, texto: string) {
      r.notas.push(texto);
      return null;
    },
  } as unknown as KommoDaOrigem;
  const deps: DepsDaOrigem = {
    estado: () => o.estado ?? 'ligado',
    async primeirasFalas(_u, _l, n) {
      r.leituras++;
      return (o.falas ?? [NAVEGANDO]).slice(0, n);
    },
    kommo: () => kommo,
    campos: async (_u, k) => (await k.listarCamposDoCartao()) as DefinicaoDeCampo[],
    // grupo null = Kommo de uma unidade só (nunca pula). Para "outra unidade" o teste usa o grupo abaixo.
    grupo: async () => (o.grupoOutraUnidade ? ({ contaUnitId: 'u-pet', membros: [{ unitId: 'u-pet', contaUnitId: 'u-pet', rotulo: 'Petrópolis' }, { unitId: 'u-cax', contaUnitId: 'u-pet', rotulo: 'Caxias' }] } as never) : null),
    simular: (_u, _a, s) => void r.simulacoes.push(s),
  };
  return { r, deps };
}

const turno = (leadId = 777, isChatMessage = true) => ({ unit: PET, leadId, isChatMessage });

beforeEach(() => {
  _semearParaTeste([]);
  _limparOrigemParaTeste();
  _limparCacheParaTeste();
  process.env.NUMEROS_INTERNOS = 'joao:98999999464';
});

// ── normalização ──────────────────────────────────────────────────────────────────────────────────

test('normalizarFrase: minúsculas, sem acento, sem pontuação nem emoji, espaços colapsados', () => {
  assert.equal(normalizarFrase('  Olá!!  Tudo   BEM?? 😀 '), 'ola tudo bem');
  assert.equal(normalizarFrase('informações, São Paulo — Ç'), 'informacoes sao paulo c');
  assert.equal(normalizarFrase('doutorhernia.com.br'), 'doutorhernia com br');
  assert.equal(normalizarFrase(null), '');
  assert.equal(normalizarFrase(undefined), '');
  assert.equal(normalizarFrase('🙂🙂'), '');
});

// ── a lista (dado) ────────────────────────────────────────────────────────────────────────────────

test('lerListaDeTextos: sem a chave ou formato errado = nada (e item ruim é descartado, não derruba)', () => {
  assert.deepEqual(lerListaDeTextos(null), []);
  assert.deepEqual(lerListaDeTextos({ scheduled_meeting: 1 }), []);
  assert.deepEqual(lerListaDeTextos([]), []);
  const avisos: string[] = [];
  assert.deepEqual(lerListaDeTextos({ [CHAVE_DA_LISTA]: 'olá' }, (m) => avisos.push(m)), []);
  assert.equal(avisos.length, 1);
  const lista = lerListaDeTextos(
    {
      [CHAVE_DA_LISTA]: [
        { texto: NAVEGANDO, origem: 'WhatsApp anúncio', anuncio: true },
        { texto: 'oi', origem: 'WhatsApp anúncio', anuncio: true }, // curta demais: casaria com tudo
        { texto: INTERESSE }, // sem origem
        { origem: 'X' }, // sem texto
        null,
        { texto: SITE, origem: 'Site oficial - Franquia', anuncio: 'sim' }, // anuncio só vale se for true de verdade
      ],
    },
    (m) => avisos.push(m),
  );
  assert.equal(lista.length, 2);
  assert.equal(lista.find((e) => e.origem === 'Site oficial - Franquia')?.anuncio, false);
  assert.equal(avisos.length, 1 + 4, 'um aviso da lista que não é lista + um por item descartado');
});

test('lerListaDeTextos: a frase mais longa vem primeiro', () => {
  const lista = lerListaDeTextos({
    [CHAVE_DA_LISTA]: [
      { texto: 'Olá, gostaria de informações', origem: 'curta' },
      { texto: 'Olá, gostaria de informações sobre a consulta', origem: 'longa' },
    ],
  });
  assert.deepEqual(lista.map((e) => e.origem), ['longa', 'curta']);
});

// ── casa / não casa ───────────────────────────────────────────────────────────────────────────────

const LISTA = lerListaDeTextos({ [CHAVE_DA_LISTA]: LISTA_BRUTA });

test('casarFala: as 4 frases reais casam, mesmo sem acento, em outra caixa ou com emoji', () => {
  assert.equal(casarFala(NAVEGANDO, LISTA)?.origem, 'WhatsApp anúncio');
  assert.equal(casarFala('olá estava navegando e gostaria de mais informações sobre tratamento', LISTA)?.origem, 'WhatsApp anúncio');
  assert.equal(casarFala('OLA ESTAVA NAVEGANDO E GOSTARIA DE MAIS INFORMACOES SOBRE TRATAMENTO 🙏', LISTA)?.origem, 'WhatsApp anúncio');
  assert.equal(casarFala(INTERESSE, LISTA)?.anuncio, true);
  assert.equal(casarFala(SITE, LISTA)?.origem, 'Site oficial - Franquia');
});

test('casarFala: o lead acrescentou algo DEPOIS da frase, ainda casa', () => {
  assert.equal(casarFala(`${NAVEGANDO} Estou com dor na coluna há 3 meses`, LISTA)?.origem, 'WhatsApp anúncio');
  assert.equal(casarFala(`${SITE}\nSou de Petrópolis`, LISTA)?.origem, 'Site oficial - Franquia');
});

test('casarFala: NÃO casa — "Bom dia", frase no MEIO da fala, frase cortada, outra frase', () => {
  assert.equal(casarFala('Bom dia', LISTA), null);
  assert.equal(casarFala('Boa tarde, tudo bem?', LISTA), null);
  assert.equal(casarFala('', LISTA), null);
  assert.equal(casarFala(`Bom dia. ${NAVEGANDO}`, LISTA), null, 'tem de COMEÇAR com a frase');
  assert.equal(casarFala('Olá estava navegando e gostaria de mais informações', LISTA), null, 'frase cortada no meio não é a frase pronta');
  assert.equal(casarFala('Tenho interesse no tratamento de hérnia', LISTA), null);
  assert.equal(casarFala('Olá estava navegando e gostaria de mais informações sobre tratamentos', LISTA), null, 'fronteira de palavra: a frase não pode terminar no meio de uma palavra');
});

test('casarPrimeirasFalas: só as primeiras falas do paciente contam', () => {
  const nada = ['Bom dia', 'Queria saber o preço', 'Qual o endereço?'];
  assert.equal(casarPrimeirasFalas([...nada, NAVEGANDO], LISTA), null, 'a frase na 4ª fala não vale');
  assert.equal(MAX_FALAS_OLHADAS, 3);
  const achou = casarPrimeirasFalas(['Bom dia', NAVEGANDO, 'Oi'], LISTA);
  assert.equal(achou?.fala, NAVEGANDO);
  assert.equal(casarPrimeirasFalas([], LISTA), null);
});

// ── resolver o enum pelo NOME ─────────────────────────────────────────────────────────────────────

test('resolverOpcao: acha a opção pelo nome do campo e da opção (nunca por id fixo)', () => {
  const r = resolverOpcao(DEFS, 'WhatsApp anúncio');
  assert.ok('opcao' in r);
  assert.equal(r.opcao.id, ENUM_WA);
  assert.equal(r.def.id, CAMPO_ORIGEM);
  // mesmo nome com outros ids (a outra conta): resolve para o id DELA
  const outraConta = DEFS.map((d) => (d.id === CAMPO_ORIGEM ? { ...d, id: 456984, enums: [{ id: 325720, value: 'WhatsApp anúncio' }] } : d));
  const r2 = resolverOpcao(outraConta, 'WhatsApp anúncio');
  assert.ok('opcao' in r2);
  assert.equal(r2.opcao.id, 325720);
  assert.equal(r2.def.id, 456984);
  // sem acento/caixa: cai no parecido, se único
  assert.ok('opcao' in resolverOpcao(DEFS, 'whatsapp anuncio'));
});

test('resolverOpcao: opção inexistente, campo ausente, campo que não é lista e ambíguo = motivo, não id', () => {
  assert.ok('motivo' in resolverOpcao(DEFS, 'Google Ads'));
  assert.ok('motivo' in resolverOpcao([DEFS[0]], 'WhatsApp anúncio'));
  assert.ok('motivo' in resolverOpcao([{ id: 5, name: NOME_DO_CAMPO_ORIGEM, type: 'text', enums: [] }], 'WhatsApp anúncio'));
  assert.ok('motivo' in resolverOpcao([...DEFS, { ...DEFS[1], id: 99 }], 'WhatsApp anúncio'), 'dois campos com o mesmo nome');
  assert.ok('motivo' in resolverOpcao([{ ...DEFS[1], enums: [{ id: 1, value: 'WhatsApp anúncio' }, { id: 2, value: 'WhatsApp anúncio' }] }], 'WhatsApp anúncio'));
  // um campo parecido mas que não é o ⚑ Origem não serve
  assert.ok('motivo' in resolverOpcao([{ id: 7, name: 'Origem', type: 'select', enums: [{ id: 1, value: 'WhatsApp anúncio' }] }], 'WhatsApp anúncio'));
});

test('planejarOrigem: campo com valor NUNCA é reescrito', () => {
  assert.equal(planejarOrigem(cartao(), DEFS, { origem: 'WhatsApp anúncio' }).tipo, 'gravar');
  const ja = planejarOrigem(cartao(285916), DEFS, { origem: 'WhatsApp anúncio' });
  assert.equal(ja.tipo, 'pular');
});

// ── a automação ───────────────────────────────────────────────────────────────────────────────────

test('catálogo: existe, tem seco, nasce desligada e o catálogo continua válido', () => {
  const a = automacaoPorId('origem-texto-pronto');
  assert.ok(a);
  assert.equal(a.chave, 'ORIGEM_TEXTO_PRONTO_SLUGS');
  assert.equal(a.risco, 'escreve-campo');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'desligado');
  assert.deepEqual(verificarCatalogo(), []);
  assert.ok(AUTOMACOES.some((x) => x.id === 'origem-texto-pronto'));
  assert.equal(estadoDaOrigemPorTexto(PET.slug, undefined), 'desligado');
  assert.equal(estadoDaOrigemPorTexto(PET.slug, PET.slug), 'ligado');
});

test('DESLIGADA: não lê conversa, não lê o Kommo, não escreve nada', async () => {
  const { r, deps } = montar({ estado: 'desligado' });
  assert.equal((await aplicarOrigemPorTexto(turno(), deps)).tipo, 'desligada');
  assert.equal(r.leituras, 0);
  assert.equal(r.getLead, 0);
  assert.equal(r.gravou.length, 0);
  assert.equal(r.simulacoes.length, 0);
});

test('SECO: registra "gravaria ⚑ Origem = X" e NÃO grava no Kommo (nem nota)', async () => {
  const { r, deps } = montar({ estado: 'seco' });
  const res = await aplicarOrigemPorTexto(turno(), deps);
  assert.deepEqual(res, { tipo: 'seco', origem: 'WhatsApp anúncio' });
  assert.equal(r.gravou.length, 0, 'seco não grava');
  assert.equal(r.notas.length, 0, 'seco não deixa nota');
  assert.equal(r.simulacoes.length, 1);
  assert.equal(r.simulacoes[0].acao, 'gravaria');
  assert.equal(r.simulacoes[0].alvo, '⚑ Origem');
  assert.equal(r.simulacoes[0].valor, 'WhatsApp anúncio');
  assert.equal(r.simulacoes[0].leadId, 777);
});

test('LIGADA: grava a opção pelo id que a CONTA tem para o nome e deixa nota', async () => {
  const { r, deps } = montar({ estado: 'ligado', falas: [INTERESSE] });
  const res = await aplicarOrigemPorTexto(turno(), deps);
  assert.deepEqual(res, { tipo: 'gravou', origem: 'WhatsApp anúncio', campo: '⚑ Origem' });
  assert.deepEqual(r.gravou, [{ leadId: 777, campos: [{ field_id: CAMPO_ORIGEM, values: [{ enum_id: ENUM_WA }] }] }]);
  assert.equal(r.notas.length, 1);
  assert.match(r.notas[0], /texto pronto/);
  assert.equal(r.simulacoes.length, 0);
});

test('LIGADA: a frase do site grava "Site oficial - Franquia"', async () => {
  const { r, deps } = montar({ estado: 'ligado', falas: [SITE] });
  await aplicarOrigemPorTexto(turno(), deps);
  assert.deepEqual(r.gravou[0].campos, [{ field_id: CAMPO_ORIGEM, values: [{ enum_id: 285915 }] }]);
});

test('NÃO REESCREVE: ⚑ Origem já preenchida (rastreio, SDR ou Sofia) fica como está — ligado e seco', async () => {
  for (const estado of ['ligado', 'seco'] as const) {
    _limparOrigemParaTeste();
    const { r, deps } = montar({ estado, lead: cartao(285916) });
    const res = await aplicarOrigemPorTexto(turno(), deps);
    assert.equal(res.tipo, 'pulou', estado);
    assert.equal(r.gravou.length, 0, estado);
    assert.equal(r.simulacoes.length, 0, estado);
    assert.equal(r.notas.length, 0, estado);
  }
});

test('opção inexistente na conta: não grava nada e avisa (nunca chuta outra opção)', async () => {
  const semOpcao = DEFS.map((d) => (d.id === CAMPO_ORIGEM ? { ...d, enums: [{ id: 285916, value: 'Indicação' }] } : d));
  const { r, deps } = montar({ estado: 'ligado', defs: semOpcao });
  const res = await aplicarOrigemPorTexto(turno(), deps);
  assert.equal(res.tipo, 'pulou');
  assert.equal(r.gravou.length, 0);
});

test('fala que não casa ("Bom dia"): não olha o cartão', async () => {
  const { r, deps } = montar({ estado: 'ligado', falas: ['Bom dia'] });
  assert.equal((await aplicarOrigemPorTexto(turno(), deps)).tipo, 'sem-casamento');
  assert.equal(r.getLead, 0, 'sem casar, nem lê o Kommo');
  assert.equal(r.gravou.length, 0);
});

test('só as 3 primeiras falas: frase na 4ª não grava, e conversa com 3 falas sem casar não é relida', async () => {
  const { r, deps } = montar({ estado: 'ligado', falas: ['Bom dia', 'Preço?', 'Onde fica?', NAVEGANDO] });
  assert.equal((await aplicarOrigemPorTexto(turno(), deps)).tipo, 'sem-casamento');
  assert.equal(r.gravou.length, 0);
  assert.equal((await aplicarOrigemPorTexto(turno(), deps)).tipo, 'ja-feito');
  assert.equal(r.leituras, 1, 'a conversa não muda mais: não gasta consulta a cada mensagem');
});

test('a frase pode vir na 2ª fala (o "Bom dia" veio antes)', async () => {
  const { r, deps } = montar({ estado: 'ligado', falas: ['Bom dia', NAVEGANDO] });
  assert.equal((await aplicarOrigemPorTexto(turno(), deps)).tipo, 'gravou');
  assert.equal(r.gravou.length, 1);
});

test('uma vez por cartão: a 2ª mensagem não relê o Kommo nem grava de novo', async () => {
  const { r, deps } = montar({ estado: 'ligado' });
  await aplicarOrigemPorTexto(turno(), deps);
  assert.equal((await aplicarOrigemPorTexto(turno(), deps)).tipo, 'ja-feito');
  assert.equal(r.getLead, 1);
  assert.equal(r.gravou.length, 1);
});

test('seco → ligado: o que foi só simulado ainda é gravado depois', async () => {
  const seco = montar({ estado: 'seco' });
  await aplicarOrigemPorTexto(turno(), seco.deps);
  assert.equal(seco.r.gravou.length, 0);
  const ligado = montar({ estado: 'ligado' });
  assert.equal((await aplicarOrigemPorTexto(turno(), ligado.deps)).tipo, 'gravou');
});

test('falha do Kommo: não grava, não lança e a próxima fala tenta de novo', async () => {
  const falho = montar({ estado: 'ligado', kommoFalha: true });
  assert.equal((await aplicarOrigemPorTexto(turno(), falho.deps)).tipo, 'pulou');
  assert.equal(falho.r.gravou.length, 0);
  const ok = montar({ estado: 'ligado' });
  assert.equal((await aplicarOrigemPorTexto(turno(), ok.deps)).tipo, 'gravou', 'a falha não foi lembrada');
});

test('mensagem que não é de chat (webhook de campo/etapa) e lead inválido são ignorados', async () => {
  const { r, deps } = montar({ estado: 'ligado' });
  assert.equal((await aplicarOrigemPorTexto(turno(777, false), deps)).tipo, 'ignorada');
  assert.equal((await aplicarOrigemPorTexto(turno(0), deps)).tipo, 'ignorada');
  assert.equal(r.leituras, 0);
});

test('unidade sem a chave origem_por_texto: nada, sem consulta', async () => {
  const { r, deps } = montar({ estado: 'ligado' });
  const sem = { ...PET, pipelineIntents: { scheduled_meeting: 1 } } as unknown as UnidadeDaOrigem;
  assert.equal((await aplicarOrigemPorTexto({ unit: sem, leadId: 5, isChatMessage: true }, deps)).tipo, 'sem-lista');
  assert.equal(r.leituras, 0);
  assert.equal(r.getLead, 0);
});

test('Kommo dividido: cartão de outra unidade (ou sem unidade) não é tocado', async () => {
  const { r, deps } = montar({ estado: 'ligado', grupoOutraUnidade: true });
  const res = await aplicarOrigemPorTexto(turno(), deps);
  assert.equal(res.tipo, 'pulou');
  assert.equal(r.gravou.length, 0);
});

test('duas mensagens em rajada não gravam duas vezes', async () => {
  const { r, deps } = montar({ estado: 'ligado' });
  const [a, b] = await Promise.all([aplicarOrigemPorTexto(turno(), deps), aplicarOrigemPorTexto(turno(), deps)]);
  assert.equal(r.gravou.length, 1);
  assert.deepEqual([a.tipo, b.tipo].sort(), ['em-curso', 'gravou']);
});

// ── o cadastro-todo-lead ──────────────────────────────────────────────────────────────────────────

const SEM_AGENDAR = deveCriarNaFranquia({ ferramentas: ['registrar_campo'] });
const CADASTRO_UNIT = { id: PET.id, slug: PET.slug, pipelineIntents: PET.pipelineIntents };

function depsDoCadastro(falasDoLead: string[], chamadas: string[]): DepsDoCadastro {
  return {
    async situacaoNaFranquia() {
      return 'nova';
    },
    async telefoneDaConversa() {
      return '5524988887777';
    },
    casamentoLigado: () => true,
    async unidadesDoTelefone() {
      return [PET.slug];
    },
    // o Lite não grava o rastreio: o cartão NÃO tem anúncio
    async anuncioDoLead() {
      return null;
    },
    async falasDoPaciente() {
      return ['Bom dia'];
    },
    async avaliarPelaIa() {
      chamadas.push('ia');
      return { decisao: 'duvida', motivo: 'só um bom dia' };
    },
    // o gancho de verdade, com o estado e o banco trocados
    anuncioPelaFrase: (unit, leadId) =>
      anuncioPelaFrase(unit, leadId, {
        estado: (slug) => estadoDaOrigemPorTexto(slug),
        primeirasFalas: async (_u, _l, n) => falasDoLead.slice(0, n),
      }),
  };
}

const semear = (cadastro: 'ligado' | 'seco', origem: 'ligado' | 'seco' | 'desligado') =>
  _semearParaTeste([
    { slug: PET.slug, automacao: 'cadastro-todo-lead', estado: cadastro },
    ...(origem === 'desligado' ? [] : [{ slug: PET.slug, automacao: 'origem-texto-pronto', estado: origem }]),
  ]);

test('cadastro-todo-lead: frase de anúncio + origem-texto-pronto LIGADA = lead de anúncio, sem a leitura da IA, sem o cartão ter nada', async () => {
  semear('ligado', 'ligado');
  const chamadas: string[] = [];
  const d = await decidirCadastroDoLead({ unit: CADASTRO_UNIT, leadId: 31, legado: SEM_AGENDAR }, depsDoCadastro([NAVEGANDO], chamadas));
  assert.equal(d.criar, true);
  assert.equal(d.soLead, true);
  assert.match(d.motivo, /anúncio/);
  assert.deepEqual(chamadas, [], 'não precisou da IA barata');
});

test('cadastro-todo-lead: com origem-texto-pronto em SECO ou DESLIGADA, o cadastro segue como hoje (a IA lê, "bom dia" = dúvida)', async () => {
  for (const origem of ['seco', 'desligado'] as const) {
    _limparCacheParaTeste();
    semear('ligado', origem);
    const chamadas: string[] = [];
    const d = await decidirCadastroDoLead({ unit: CADASTRO_UNIT, leadId: 32, legado: SEM_AGENDAR }, depsDoCadastro([NAVEGANDO], chamadas));
    assert.equal(d.criar, false, origem);
    assert.deepEqual(chamadas, ['ia'], origem);
  }
});

test('cadastro-todo-lead: frase com anuncio:false NÃO vira anúncio; fala que não casa também não', async () => {
  semear('ligado', 'ligado');
  const chamadas: string[] = [];
  const naoAnuncio = await decidirCadastroDoLead({ unit: CADASTRO_UNIT, leadId: 33, legado: SEM_AGENDAR }, depsDoCadastro(['Olá! Posso ter mais informações sobre isso? (frase de teste fora do anúncio)'], chamadas));
  assert.equal(naoAnuncio.criar, false);
  _limparCacheParaTeste();
  const bomDia = await decidirCadastroDoLead({ unit: CADASTRO_UNIT, leadId: 34, legado: SEM_AGENDAR }, depsDoCadastro(['Bom dia'], chamadas));
  assert.equal(bomDia.criar, false);
  assert.deepEqual(chamadas, ['ia', 'ia']);
});

test('cadastro-todo-lead: a frase de anúncio NÃO passa por cima das travas (interno, 3+ unidades, sem casamento)', async () => {
  semear('ligado', 'ligado');
  process.env.NUMEROS_INTERNOS = 'joao:24988887777';
  const interno = await decidirCadastroDoLead({ unit: CADASTRO_UNIT, leadId: 35, legado: SEM_AGENDAR }, depsDoCadastro([NAVEGANDO], []));
  assert.equal(interno.criar, false, 'número interno continua barrado');
  process.env.NUMEROS_INTERNOS = 'outro:24900000000';
  _limparCacheParaTeste();
  const base = depsDoCadastro([NAVEGANDO], []);
  const semCasamento = await decidirCadastroDoLead({ unit: CADASTRO_UNIT, leadId: 36, legado: SEM_AGENDAR }, { ...base, casamentoLigado: () => false });
  assert.equal(semCasamento.criar, false, 'sem o casamento cartão × paciente nada de lead novo');
});

test('anuncioPelaFrase: só LIGADA devolve, e não consulta a conversa quando não é ligada', async () => {
  let leituras = 0;
  const primeirasFalas = async () => {
    leituras++;
    return [NAVEGANDO];
  };
  assert.equal(await anuncioPelaFrase(PET, 1, { estado: () => 'seco', primeirasFalas }), null);
  assert.equal(await anuncioPelaFrase(PET, 1, { estado: () => 'desligado', primeirasFalas }), null);
  assert.equal(leituras, 0);
  assert.equal((await anuncioPelaFrase(PET, 1, { estado: () => 'ligado', primeirasFalas }))?.origem, 'WhatsApp anúncio');
  // banco fora: nunca lança, vira "não é anúncio" (orgânico passa pela IA)
  assert.equal(await anuncioPelaFrase(PET, 1, { estado: () => 'ligado', primeirasFalas: async () => { throw new Error('banco'); } }), null);
});

// ── a lista não pode vazar para o prompt da Sofia ─────────────────────────────────────────────────

test('prompt-composer: origem_por_texto está na lista de chaves de configuração (senão vira "mover para a etapa [object Object]")', () => {
  const fonte = readFileSync(new URL('../agent/prompt-composer.ts', import.meta.url), 'utf8');
  const bloco = fonte.slice(fonte.indexOf('PIPELINE_INTENT_CONFIG_KEYS = new Set(['), fonte.indexOf(']);', fonte.indexOf('PIPELINE_INTENT_CONFIG_KEYS = new Set([')));
  assert.ok(bloco.includes(`'${CHAVE_DA_LISTA}'`));
});
