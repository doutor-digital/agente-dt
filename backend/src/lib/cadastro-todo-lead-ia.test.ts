/**
 * "Veio de anúncio é lead; o resto a IA lê" (27/10/2026) — o que o pedido do João exige e não pode escapar:
 *  - anúncio NÃO fura número interno nem a trava de 3+ unidades;
 *  - orgânico: `lead` cadastra, `nao_lead` barra com motivo, `duvida` não cadastra e reavalia;
 *  - a IA falhando é dúvida, nunca cadastro; no máximo 3 leituras por lead, 1 a cada 10 min, só com fala nova;
 *  - DESLIGADO é a regra de 26/09 byte a byte; SECO decide e loga, mas não cria nada.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { _semearParaTeste } from './automacoes-estado.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { deveCriarNaFranquia } from './cadastro-na-franquia.js';
import {
  ESPERA_ENTRE_LEITURAS_MS,
  MAX_LEITURAS_DA_IA,
  _limparCacheParaTeste,
  cadastrarLeadDoTurno,
  decidirCadastroDoLead,
  depsPadrao,
  type DepsDoCadastro,
} from './cadastro-todo-lead.js';
import type { AnuncioDeOrigem } from '../agent/anuncio-de-origem.js';
import type { DecisaoDaIa } from './cadastro-triagem-ia.js';

const SERRA = { id: 'u-serra', slug: 'doutor-hernia-serra' };
const INTERNO = '5598999999464';
const PACIENTE = '5598988887777';

const SEM_AGENDAR = deveCriarNaFranquia({ ferramentas: ['registrar_campo'] });
const AGENDOU = deveCriarNaFranquia({ ferramentas: ['agendar_consulta'] });

const DE_ANUNCIO: AnuncioDeOrigem = { titulo: null, anuncio: null, campanha: 'DH Serra · Coluna', plataforma: 'Instagram', origem: 'Meta-Instagram' };
const DE_REEL: AnuncioDeOrigem = { titulo: null, anuncio: 'reel-123', campanha: null, plataforma: 'Instagram', origem: 'Org-Instagram' };

const LEAD: DecisaoDaIa = { decisao: 'lead', motivo: 'perguntou o preço da consulta para a dor na lombar' };
const NAO_LEAD: DecisaoDaIa = { decisao: 'nao_lead', motivo: 'vendedor oferecendo camisetas' };
const DUVIDA: DecisaoDaIa = { decisao: 'duvida', motivo: 'só disse oi' };

type Opcoes = Partial<{
  telefone: string | null;
  unidades: string[];
  anuncio: AnuncioDeOrigem | null | Error;
  falas: string[] | (() => string[]) | Error;
  ia: DecisaoDaIa | Error | (() => Promise<DecisaoDaIa>);
}>;

function deps(o: Opcoes = {}): DepsDoCadastro & { chamadas: string[]; leituras: Array<readonly string[]> } {
  const chamadas: string[] = [];
  const leituras: Array<readonly string[]> = [];
  return {
    chamadas,
    leituras,
    async situacaoNaFranquia() {
      chamadas.push('situacao');
      return 'nova';
    },
    async telefoneDaConversa() {
      return o.telefone === undefined ? PACIENTE : o.telefone;
    },
    casamentoLigado: () => true,
    async unidadesDoTelefone() {
      chamadas.push('unidades');
      return o.unidades ?? [SERRA.slug];
    },
    async anuncioDoLead() {
      chamadas.push('anuncio');
      if (o.anuncio instanceof Error) throw o.anuncio;
      return o.anuncio ?? null;
    },
    async falasDoPaciente() {
      chamadas.push('falas');
      if (o.falas instanceof Error) throw o.falas;
      return typeof o.falas === 'function' ? o.falas() : (o.falas ?? ['oi']);
    },
    async avaliarPelaIa(_unit, falas) {
      chamadas.push('ia');
      leituras.push(falas);
      if (typeof o.ia === 'function') return o.ia();
      if (o.ia instanceof Error) throw o.ia;
      return o.ia ?? DUVIDA;
    },
  };
}

const ligar = (estado: 'ligado' | 'seco') => _semearParaTeste([{ slug: SERRA.slug, automacao: 'cadastro-todo-lead', estado }]);
const vezesQue = (d: { chamadas: string[] }, quem: string) => d.chamadas.filter((c) => c === quem).length;

// Log e tela "só no papel" capturados — nada vai ao banco nem ao stdout.
let linhas: Array<{ nivel: string; obj: Record<string, unknown>; msg: string }> = [];
let simulacoes: Array<Record<string, unknown>> = [];

beforeEach(() => {
  _semearParaTeste([]);
  _limparCacheParaTeste();
  process.env.NUMEROS_INTERNOS = `joao:98999999464`;
  linhas = [];
  simulacoes = [];
  for (const nivel of ['info', 'warn'] as const) {
    mock.method(logger, nivel, ((obj: unknown, msg?: string) => {
      linhas.push({ nivel, obj: (typeof obj === 'object' && obj ? obj : {}) as Record<string, unknown>, msg: typeof obj === 'string' ? obj : (msg ?? '') });
    }) as never);
  }
  Object.defineProperty(prisma, 'automacaoSimulacao', {
    value: { upsert: async (a: { create: Record<string, unknown> }) => { simulacoes.push(a.create); }, deleteMany: async () => ({ count: 0 }) },
    configurable: true,
  });
});

afterEach(() => mock.restoreAll());

// ── anúncio é lead — mas não fura as duas travas ─────────────────────────────────────────────

test('anúncio + número interno: BARRA (anúncio não fura NUMEROS_INTERNOS) e nem lê o cartão nem chama a IA', async () => {
  ligar('ligado');
  const d = deps({ telefone: INTERNO, anuncio: DE_ANUNCIO });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1001, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, false);
  assert.match(r.motivo, /interno/);
  assert.equal(vezesQue(d, 'anuncio'), 0);
  assert.equal(vezesQue(d, 'ia'), 0);
});

test('anúncio + telefone em 3 unidades: BARRA (anúncio não fura a trava automática)', async () => {
  ligar('ligado');
  const d = deps({ anuncio: DE_ANUNCIO, unidades: ['doutor-hernia-serra', 'doutor-hernia-mossoro', 'doutor-hernia-canaa'] });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1002, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, false);
  assert.match(r.motivo, /varias-unidades/);
  assert.equal(vezesQue(d, 'ia'), 0);
});

test('anúncio cadastra como LEAD, sem gastar a leitura da IA — mesmo que a conversa seja só um "oi"', async () => {
  ligar('ligado');
  const d = deps({ anuncio: DE_ANUNCIO, falas: ['oi'], ia: DUVIDA });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1003, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, true);
  assert.equal(r.soLead, true);
  assert.match(r.motivo, /anúncio/);
  assert.equal(vezesQue(d, 'falas'), 0);
  assert.equal(vezesQue(d, 'ia'), 0);
});

test('só Meta-* ou campanha preenchida é anúncio: Reel orgânico (Org-*) e cartão sem rastreio passam pela IA', async () => {
  ligar('ligado');
  for (const [i, anuncio] of [[1, DE_REEL], [2, null], [3, { ...DE_REEL, origem: null }]] as const) {
    const d = deps({ anuncio, falas: ['oi'], ia: DUVIDA });
    const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1010 + i, legado: SEM_AGENDAR }, d);
    assert.equal(r.criar, false, `caso ${i}`);
    assert.equal(vezesQue(d, 'ia'), 1, `caso ${i}: orgânico é lido pela IA`);
  }
});

test('o cartão não pôde ser lido: na dúvida é orgânico (vai para a IA), nunca anúncio', async () => {
  ligar('ligado');
  const d = deps({ anuncio: new Error('Kommo fora'), falas: ['quanto custa a consulta?'], ia: LEAD });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1020, legado: SEM_AGENDAR }, d);
  assert.equal(vezesQue(d, 'ia'), 1);
  assert.equal(r.criar, true);
  assert.match(r.motivo, /IA leu a conversa/);
});

// ── orgânico: a IA decide ────────────────────────────────────────────────────────────────────

test('orgânico + IA diz lead: cadastra só como LEAD, e a IA recebeu as falas do paciente', async () => {
  ligar('ligado');
  const falas = ['oi', 'queria saber o preço da consulta', 'tenho hérnia de disco'];
  const d = deps({ falas, ia: LEAD });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1030, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, true);
  assert.equal(r.soLead, true);
  assert.deepEqual(d.leituras, [falas]);
});

test('orgânico + IA diz nao_lead: barra, com o motivo, e a decisão é silenciosa no webhook', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1031, legado: SEM_AGENDAR }, deps({ falas: ['Olá, trabalhamos com camisetas personalizadas'], ia: NAO_LEAD }));
  assert.equal(r.criar, false);
  assert.match(r.motivo, /nao-lead.*camisetas/);
  assert.equal(r.silenciosa, true);
  assert.ok(linhas.some((l) => /barrou pela IA: vendedor oferecendo camisetas/.test(l.msg)), 'o motivo vai para o log');
});

test('orgânico + IA diz dúvida ("oi"): não cadastra agora', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1032, legado: SEM_AGENDAR }, deps({ falas: ['oi'], ia: DUVIDA }));
  assert.equal(r.criar, false);
  assert.match(r.motivo, /duvida/);
  assert.equal(r.silenciosa, true);
});

test('a IA falhando é DÚVIDA, nunca cadastro (erro lançado, resposta fora do formato, veredito inventado)', async () => {
  ligar('ligado');
  const casos: Array<[string, Opcoes['ia']]> = [
    ['lançou', new Error('Anthropic 529')],
    ['sem decisão', (async () => ({}) as DecisaoDaIa) as () => Promise<DecisaoDaIa>],
    ['decisão inventada', (async () => ({ decisao: 'talvez', motivo: 'x' }) as unknown as DecisaoDaIa) as () => Promise<DecisaoDaIa>],
    ['falhou declarada', (async () => ({ decisao: 'duvida', motivo: 'timeout', falhou: true }) as DecisaoDaIa) as () => Promise<DecisaoDaIa>],
  ];
  let id = 1040;
  for (const [nome, ia] of casos) {
    const r = await decidirCadastroDoLead({ unit: SERRA, leadId: id++, legado: SEM_AGENDAR }, deps({ falas: ['quero marcar consulta'], ia }));
    assert.equal(r.criar, false, nome);
    assert.match(r.motivo, /duvida/, nome);
  }
  // não conseguir ler as mensagens também é dúvida, e nem chega a chamar a IA
  const d = deps({ falas: new Error('banco fora') });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1050, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, false);
  assert.equal(vezesQue(d, 'ia'), 0);
});

test('conversa sem nenhuma fala de texto do paciente: dúvida, sem chamar a IA e sem gastar leitura', async () => {
  ligar('ligado');
  const d = deps({ falas: [' ', ''] });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1051, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, false);
  assert.equal(vezesQue(d, 'ia'), 0);
});

test('quem AGENDOU não passa pela leitura da IA: segue a regra de 26/09 (não é dúvida)', async () => {
  ligar('ligado');
  const d = deps({ ia: NAO_LEAD });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 1052, legado: AGENDOU }, d);
  assert.equal(r.criar, true);
  assert.equal(r.soLead, false);
  assert.equal(vezesQue(d, 'anuncio') + vezesQue(d, 'ia'), 0);
});

// ── custo: 3 leituras por lead, 1 a cada 10 min, só com fala nova ────────────────────────────

test('no máximo 3 leituras por lead, a cada 10 min, e só quando o paciente escreveu algo novo', async () => {
  ligar('ligado');
  let agora = Date.UTC(2026, 9, 27, 12, 0, 0);
  mock.method(Date, 'now', () => agora);
  let falas = ['oi'];
  const veredito: DecisaoDaIa[] = [DUVIDA, DUVIDA, NAO_LEAD];
  const d = deps({ falas: () => falas, ia: async () => veredito.shift() ?? LEAD });
  const decidir = () => decidirCadastroDoLead({ unit: SERRA, leadId: 1060, legado: SEM_AGENDAR }, d);

  assert.match((await decidir()).motivo, /duvida/);
  assert.equal(vezesQue(d, 'ia'), 1, 'leitura 1');

  // 5 minutos depois, com fala nova: ainda dentro dos 10 min — reaproveita a leitura
  agora += 5 * 60_000;
  falas = ['oi', 'tudo bem?'];
  await decidir();
  assert.equal(vezesQue(d, 'ia'), 1, 'dentro de 10 min não lê de novo');

  // passou o intervalo: a fala de 6 minutos atrás entra agora
  agora += 6 * 60_000;
  falas = ['oi', 'tudo bem?'];
  await decidir();
  assert.equal(vezesQue(d, 'ia'), 2, 'leitura 2');
  // passou o intervalo, mas o paciente não escreveu nada novo: ler de novo seria pagar pela mesma resposta
  agora += 11 * 60_000;
  await decidir();
  assert.equal(vezesQue(d, 'ia'), 2, 'sem fala nova depois da leitura, não lê');

  // fala nova depois do intervalo: leitura 3 — e agora a IA vê que é fornecedor
  agora += ESPERA_ENTRE_LEITURAS_MS;
  falas = ['oi', 'tudo bem?', 'trabalhamos com camisetas'];
  const terceira = await decidir();
  assert.equal(vezesQue(d, 'ia'), 3, 'leitura 3');
  assert.match(terceira.motivo, /nao-lead/);

  // o teto: nem com fala nova e muito tempo depois
  agora += 3 * ESPERA_ENTRE_LEITURAS_MS;
  falas = [...falas, 'e então?'];
  const quarta = await decidir();
  assert.equal(vezesQue(d, 'ia'), MAX_LEITURAS_DA_IA, 'nunca passa de 3');
  assert.match(quarta.motivo, /nao-lead/, 'vale a última leitura');
});

test('"lead" é definitivo: depois que a IA viu interesse real, as próximas mensagens não pagam outra leitura', async () => {
  ligar('ligado');
  const d = deps({ falas: ['quanto custa?'], ia: LEAD });
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 1070, legado: SEM_AGENDAR }, d)).criar, true);
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 1070, legado: SEM_AGENDAR }, d)).criar, true);
  assert.equal(vezesQue(d, 'ia'), 1);
});

test('rajada: duas mensagens simultâneas do mesmo lead dividem UMA leitura', async () => {
  ligar('ligado');
  let solta!: () => void;
  const trava = new Promise<void>((r) => { solta = r; });
  const d = deps({ falas: ['oi'], ia: async () => { await trava; return DUVIDA; } });
  const a = decidirCadastroDoLead({ unit: SERRA, leadId: 1071, legado: SEM_AGENDAR }, d);
  const b = decidirCadastroDoLead({ unit: SERRA, leadId: 1071, legado: SEM_AGENDAR }, d);
  await new Promise((r) => setImmediate(r));
  solta();
  await Promise.all([a, b]);
  assert.equal(vezesQue(d, 'ia'), 1);
});

// ── estados ──────────────────────────────────────────────────────────────────────────────────

test('DESLIGADO: é exatamente a regra de 26/09 — nenhuma leitura de cartão, de mensagem nem de IA', async () => {
  const d = deps({ ia: LEAD, anuncio: DE_ANUNCIO });
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 1080, legado: SEM_AGENDAR }, d), SEM_AGENDAR);
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 1081, legado: AGENDOU }, d), AGENDOU);
  assert.deepEqual(d.chamadas, []);
  const g = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 1082, ferramentas: [] }, async () => { throw new Error('não podia chamar'); }, d);
  assert.equal(g.execucao, null);
  assert.deepEqual(d.chamadas, []);
});

test('SECO decide e loga, mas NÃO cria nada: devolve sempre a regra de 26/09 e o sincronizador nunca é chamado', async () => {
  ligar('seco');
  let sincronizados = 0;
  const sincronizar = async () => { sincronizados++; };
  const casos: Array<[number, Opcoes]> = [
    [1090, { anuncio: DE_ANUNCIO }],
    [1091, { falas: ['preciso de consulta para dor ciática'], ia: LEAD }],
    [1092, { falas: ['vendemos camisetas'], ia: NAO_LEAD }],
    [1093, { falas: ['oi'], ia: DUVIDA }],
    [1094, { falas: ['oi'], ia: new Error('API fora') }],
  ];
  for (const [id, o] of casos) {
    const r = await cadastrarLeadDoTurno({ unit: SERRA, leadId: id, ferramentas: [] }, sincronizar, deps(o));
    assert.equal(r.execucao, null, `lead ${id}`);
    assert.deepEqual(r.decisao, SEM_AGENDAR, `lead ${id}`);
  }
  assert.equal(sincronizados, 0);

  const textos = linhas.map((l) => l.msg);
  assert.ok(textos.some((t) => /\[seco\]: cadastraria \(anúncio\)/.test(t)), 'anúncio: cadastraria');
  assert.ok(textos.some((t) => /\[seco\]: cadastraria pela IA — .*perguntou o preço/.test(t)), 'IA: cadastraria pela IA');
  assert.ok(textos.some((t) => /\[seco\]: barraria pela IA: vendedor oferecendo camisetas/.test(t)), 'IA: barraria pela IA: <motivo>');
  assert.ok(textos.some((t) => /\[seco\]: dúvida — só disse oi.*não cadastraria agora/.test(t)), 'IA: dúvida');
  // e a tela "só no papel" recebe a mesma coisa (gravaria / pularia), sem tocar em mais nada
  const porLead = (id: number) => simulacoes.find((s) => s.kommoLeadId === id);
  assert.equal(porLead(1090)?.acao, 'gravaria');
  assert.equal(porLead(1091)?.acao, 'gravaria');
  assert.match(String(porLead(1091)?.valor), /IA/);
  assert.equal(porLead(1092)?.acao, 'pularia');
  assert.equal(porLead(1092)?.valor, 'nao-lead-pela-ia');
  assert.equal(porLead(1093)?.valor, 'duvida-da-ia');
});

test('SECO: quem agendou é o mesmo de sempre — não lê o cartão e não chama a IA', async () => {
  ligar('seco');
  const d = deps({ ia: NAO_LEAD });
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 1095, legado: AGENDOU }, d), AGENDOU);
  assert.equal(vezesQue(d, 'anuncio') + vezesQue(d, 'ia'), 0);
});

test('LIGADO: o fluxo inteiro dispara UM cadastro só como lead para o que a IA aprovou, e nenhum para o que ela barrou', async () => {
  ligar('ligado');
  const recebidas: Array<{ soLead?: boolean }> = [];
  const sincronizar = async (_u: unknown, _l: number, o: { soLead?: boolean }) => { recebidas.push(o); };
  const ok = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 1100, ferramentas: [] }, sincronizar, deps({ falas: ['quero marcar'], ia: LEAD }));
  await ok.execucao;
  const nao = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 1101, ferramentas: [] }, sincronizar, deps({ falas: ['spam'], ia: NAO_LEAD }));
  assert.equal(nao.execucao, null);
  assert.deepEqual(recebidas, [{ soLead: true }]);
});

// ── privacidade e o que a IA lê ──────────────────────────────────────────────────────────────

test('o telefone inteiro nunca vai ao log nem à tela "só no papel" — só o final', async () => {
  ligar('seco');
  await decidirCadastroDoLead({ unit: SERRA, leadId: 1110, legado: SEM_AGENDAR }, deps({ falas: ['oi'], ia: DUVIDA }));
  await decidirCadastroDoLead({ unit: SERRA, leadId: 1111, legado: SEM_AGENDAR }, deps({ anuncio: DE_ANUNCIO }));
  assert.ok(linhas.length >= 2);
  const tudo = JSON.stringify([linhas, simulacoes]);
  assert.ok(!tudo.includes(PACIENTE), 'telefone inteiro no log');
  assert.ok(!tudo.includes(PACIENTE.slice(-8)), 'os 8 últimos dígitos também não');
  assert.ok(tudo.includes('…7777'), 'o final identifica o lead');
});

test('padrão: lê SÓ as falas do paciente (role user), as 10 últimas, da mais antiga para a mais nova', async () => {
  const achados: unknown[] = [];
  Object.defineProperty(prisma, 'message', {
    value: {
      findMany: async (a: unknown) => {
        achados.push(a);
        return [{ content: 'terceira' }, { content: 'segunda' }, { content: 'primeira' }];
      },
    },
    configurable: true,
  });
  const falas = await depsPadrao.falasDoPaciente(SERRA, 1120);
  assert.deepEqual(falas, ['primeira', 'segunda', 'terceira']);
  const a = achados[0] as { where: { role: string; conversation: { unitId: string; leadId: string } }; take: number; orderBy: { createdAt: string } };
  assert.equal(a.where.role, 'user', 'nunca as respostas da IA');
  assert.deepEqual(a.where.conversation, { unitId: 'u-serra', leadId: '1120' });
  assert.equal(a.take, 10);
  assert.equal(a.orderBy.createdAt, 'desc');
});

test('padrão: sem a Unit inteira (sem kommoSubdomain) não há como ler o cartão — null, ou seja, orgânico', async () => {
  assert.equal(await depsPadrao.anuncioDoLead(SERRA, 1130), null);
});
