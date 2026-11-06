/**
 * Leads de entrada (06/11/2026): vincular o duplicado, aceitar quem não tem cartão, e NUNCA aceitar conversa velha.
 * O Kommo aqui é falso: a porta guarda tudo que foi pedido, para provar também o que NÃO foi escrito.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import type { EntradaDoKommo, KommoLead, KommoPipeline } from '../services/kommo.service.js';
import { KommoApiError, createKommoClientSemFreio } from '../services/kommo.service.js';
import {
  BLOQUEIO_MS,
  DESCANSO_CURTO_MS,
  ID_ENTRADA,
  ID_ESTOQUE,
  cartaoAberto,
  chaveFone,
  classeDoErro,
  configDoAmbiente,
  decidir,
  etapasDeEntrada,
  memoriaNova,
  mesmoTelefone,
  primeiraEtapaDoFunil,
  rodarConta,
  type ConfigEntrada,
  type ContextoDaRodada,
  type PortaKommo,
} from './entrada-automatica.js';
import { agruparPorConta, estadoDaConta } from './entrada-automatica-worker.js';
import { AUTOMACOES, automacaoPorChave, automacaoPorId, verificarCatalogo } from './automacoes.js';

const AGORA = 1_800_000_000;
const MIN = 60;
const FUNIL = 14523243;
const ENTRADA = 112189467; // type 1
const QUALIFICACAO = 112321351;
const AGENDADO = 112321359;

const PIPELINES: KommoPipeline[] = [
  {
    id: FUNIL,
    name: 'COMERCIAL',
    is_main: true,
    statuses: [
      { id: 143, name: 'PERDIDO', sort: 11000 },
      { id: AGENDADO, name: 'AGENDADO', sort: 50, type: 0 },
      { id: QUALIFICACAO, name: 'EM QUALIFICAÇÃO', sort: 20, type: 0 },
      { id: ENTRADA, name: 'Etapa de leads de entrada', sort: 10, type: 1 },
      { id: 142, name: 'GANHO', sort: 10000 },
    ],
  },
];

const CFG: ConfigEntrada = { esperaS: 3 * MIN, janelaS: 120 * MIN, maxAvaliacoes: 30, maxEscritas: 15, maxPaginas: 4 };

interface ContatoFalso {
  id: number;
  telefones: string[];
  leadIds: number[];
}

/** Um Kommo falso inteiro: a caixa, os contatos, os cartões. Falhas por chamada com `falhar`. */
function kommoFalso(m: { caixa: EntradaDoKommo[]; contatos: ContatoFalso[]; cartoes: Array<Partial<KommoLead> & { id: number }>; pipelines?: KommoPipeline[] }) {
  const chamadas: string[] = [];
  const escritas: Array<{ tipo: 'vincular' | 'aceitar' | 'nota'; args: unknown[] }> = [];
  const falhar: Record<string, Array<unknown>> = {}; // 'vincular' -> [erro1, erro2…] consumidos em ordem
  const falha = (nome: string) => {
    const f = falhar[nome]?.shift();
    if (f) throw f;
  };
  const porta: PortaKommo = {
    async listarEntrada(op) {
      chamadas.push('listarEntrada');
      falha('listarEntrada');
      assert.equal(op?.categoria, 'chats', 'a rodada só pede chats');
      return { itens: [...m.caixa], completa: true };
    },
    async telefonesDoContato(id) {
      chamadas.push('telefonesDoContato');
      falha('telefonesDoContato');
      return m.contatos.find((c) => c.id === id)?.telefones ?? [];
    },
    async buscarContatos(texto, limite) {
      chamadas.push('buscarContatos');
      assert.equal(limite, 50);
      if (falhar.busca?.length) {
        falhar.busca.shift();
        return null; // o Kommo real devolve null quando a consulta falha
      }
      const k = texto.replace(/\D/g, '');
      return m.contatos
        .filter((c) => c.telefones.some((t) => t.replace(/\D/g, '').endsWith(k)))
        .map((c) => ({ id: c.id, nome: null, telefone: c.telefones[0] ?? null, telefones: c.telefones, leadIds: c.leadIds }));
    },
    async listLeadsPorIds(ids) {
      chamadas.push('listLeadsPorIds');
      falha('listLeadsPorIds');
      return m.cartoes.filter((c) => ids.includes(c.id)) as KommoLead[];
    },
    async listPipelines() {
      chamadas.push('listPipelines');
      return m.pipelines ?? PIPELINES;
    },
    async vincularEntrada(uid, leadId) {
      falha('vincular');
      escritas.push({ tipo: 'vincular', args: [uid, leadId] });
    },
    async aceitarEntrada(uid, statusId) {
      falha('aceitar');
      escritas.push({ tipo: 'aceitar', args: [uid, statusId] });
      return { leadId: 9_000_000 + escritas.length };
    },
    async addLeadNote(leadId, text) {
      escritas.push({ tipo: 'nota', args: [leadId, text] });
      return { id: 1 };
    },
  };
  return { porta, chamadas, escritas, falhar };
}

const lead = (uid: string, criadoHaMin: number, contatoId: number, extra: Partial<EntradaDoKommo> = {}): EntradaDoKommo => ({
  uid,
  pipelineId: FUNIL,
  categoria: 'chats',
  criadoEm: AGORA - criadoHaMin * MIN,
  leadId: 5_000_000 + contatoId,
  contatoId,
  ...extra,
});

const cartao = (id: number, statusId = QUALIFICACAO, extra: Partial<KommoLead> = {}): Partial<KommoLead> & { id: number } => ({
  id,
  pipeline_id: FUNIL,
  status_id: statusId,
  closed_at: null,
  ...extra,
});

function ctx(sobre: Partial<ContextoDaRodada> = {}) {
  const simulacoes: Array<Record<string, unknown>> = [];
  const c: ContextoDaRodada = {
    unit: { id: 'u1', slug: 'doutor-hernia-timbo' },
    recente: 'ligado',
    estoque: 'desligado',
    agora: AGORA,
    cfg: CFG,
    memoria: memoriaNova(),
    registrar: (s) => simulacoes.push({ ...s }),
    pausa: async () => undefined,
    ...sobre,
  };
  return { c, simulacoes };
}

const FONE = '+55 47 99917-2442';
const FONE_SEM_NONO = '(47) 9917-2442'; // o mesmo número, gravado sem o nono dígito

// ─── regras puras ─────────────────────────────────────────────────────────────────────────────────

test('telefone: últimos 8 dígitos atravessam o nono dígito e o +55; DDD diferente não casa', () => {
  assert.equal(chaveFone(FONE), '99172442');
  assert.equal(chaveFone('123'), null);
  assert.ok(mesmoTelefone(FONE, FONE_SEM_NONO));
  assert.ok(mesmoTelefone('47999172442', '99172442'), 'sem DDD de um dos lados vale o final');
  assert.ok(!mesmoTelefone('47999172442', '11999172442'), 'mesmos 8 dígitos em outro DDD é outra pessoa');
  assert.ok(!mesmoTelefone(FONE, '47 99917-2443'));
});

test('primeira etapa do funil: pula a de entrada (type 1) e GANHO/PERDIDO, pela ordem (sort), não pela posição na lista', () => {
  assert.deepEqual(primeiraEtapaDoFunil(PIPELINES, FUNIL), { id: QUALIFICACAO, nome: 'EM QUALIFICAÇÃO' });
  assert.equal(primeiraEtapaDoFunil(PIPELINES, 1), null, 'funil que não existe: não chuta');
  const magalhaes: KommoPipeline[] = [
    { id: 7, name: 'Comercial', statuses: [{ id: 2, name: '1 - Lead novo', sort: 20 }, { id: 1, name: 'Incoming leads', sort: 10, type: 1 }, { id: 3, name: '2 - Em qualificação', sort: 30 }] },
  ];
  assert.deepEqual(primeiraEtapaDoFunil(magalhaes, 7), { id: 2, nome: '1 - Lead novo' }, 'conta fora do padrão Doutor Hérnia');
  assert.equal(primeiraEtapaDoFunil([{ id: 7, name: 'x', is_archive: true, statuses: magalhaes[0].statuses }], 7), null, 'funil arquivado');
});

test('cartão aberto: fora de 142/143, sem closed_at e fora da etapa de entrada', () => {
  const entrada = etapasDeEntrada(PIPELINES);
  assert.ok(cartaoAberto({ pipeline_id: FUNIL, status_id: QUALIFICACAO, closed_at: null }, entrada));
  assert.ok(!cartaoAberto({ pipeline_id: FUNIL, status_id: 143, closed_at: null }, entrada));
  assert.ok(!cartaoAberto({ pipeline_id: FUNIL, status_id: 142, closed_at: null }, entrada));
  assert.ok(!cartaoAberto({ pipeline_id: FUNIL, status_id: QUALIFICACAO, closed_at: 1 }, entrada));
  assert.ok(!cartaoAberto({ pipeline_id: FUNIL, status_id: ENTRADA, closed_at: null }, entrada), 'cartão na etapa de entrada é lead de entrada');
});

test('decidir: um aberto vincula; vários não decidem; nenhum aceita só se for recente; sem telefone ou busca cheia nunca aceita', () => {
  const ok = { temTelefone: true, buscaCheia: false };
  assert.deepEqual(decidir('recente', ok, [7]), { tipo: 'vincular', cartaoId: 7 });
  assert.deepEqual(decidir('estoque', ok, [7]), { tipo: 'vincular', cartaoId: 7 });
  assert.deepEqual(decidir('recente', ok, [7, 8]), { tipo: 'nada', motivo: 'ambiguo' });
  assert.deepEqual(decidir('estoque', ok, [7, 8]), { tipo: 'nada', motivo: 'ambiguo' });
  assert.deepEqual(decidir('recente', ok, []), { tipo: 'aceitar' });
  assert.deepEqual(decidir('estoque', ok, []), { tipo: 'nada', motivo: 'sem-par-velho' });
  assert.deepEqual(decidir('recente', { temTelefone: false, buscaCheia: false }, []), { tipo: 'nada', motivo: 'sem-telefone' });
  assert.deepEqual(decidir('recente', { temTelefone: true, buscaCheia: true }, []), { tipo: 'nada', motivo: 'busca-cheia' });
  assert.deepEqual(decidir('recente', { temTelefone: true, buscaCheia: true }, [7]), { tipo: 'nada', motivo: 'busca-cheia' });
});

test('classe do erro: 404 já resolvido; 400/401/403/422 não passam; o resto passa', () => {
  assert.equal(classeDoErro(new KommoApiError('x', 404, {})), 'ja-resolvido');
  for (const s of [400, 401, 403, 422]) assert.equal(classeDoErro(new KommoApiError('x', s, {})), 'permanente');
  for (const s of [429, 500, 502, 503, undefined]) assert.equal(classeDoErro(new KommoApiError('x', s, {})), 'transitorio');
  assert.equal(classeDoErro(new Error('ECONNRESET')), 'transitorio');
});

test('config: padrões 3 min / 120 min / 30 / 15, e lixo no ambiente cai no padrão', () => {
  const p = configDoAmbiente({});
  assert.deepEqual([p.esperaS, p.janelaS, p.maxAvaliacoes, p.maxEscritas], [180, 7200, 30, 15]);
  const q = configDoAmbiente({ ENTRADA_JANELA_MIN: '30', ENTRADA_MAX_ESCRITAS: '2', ENTRADA_ESPERA_MIN: '0' } as never);
  assert.deepEqual([q.janelaS, q.maxEscritas, q.esperaS], [1800, 2, 0]);
  assert.equal(configDoAmbiente({ ENTRADA_JANELA_MIN: 'abc', ENTRADA_MAX_AVALIACOES: '-4' } as never).janelaS, 7200);
});

// ─── a rodada ─────────────────────────────────────────────────────────────────────────────────────

test('PAR ÚNICO: lead recente com o telefone de UM cartão aberto é vinculado a ele — e nada mais é escrito', async () => {
  const k = kommoFalso({
    caixa: [lead('u-a', 10, 1)],
    contatos: [
      { id: 1, telefones: [FONE], leadIds: [5_000_001] },
      { id: 2, telefones: [FONE_SEM_NONO], leadIds: [321] }, // o contato do cartão de verdade: outro formato do mesmo número
    ],
    cartoes: [cartao(321)],
  });
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  assert.equal(r.vinculados, 1);
  assert.equal(r.aceitos, 0);
  assert.deepEqual(k.escritas.filter((e) => e.tipo !== 'nota').map((e) => [e.tipo, ...e.args]), [['vincular', 'u-a', 321]]);
  assert.equal(k.escritas.filter((e) => e.tipo === 'nota').length, 1, 'uma nota no cartão diz o que aconteceu');
  assert.equal(k.escritas.find((e) => e.tipo === 'nota')?.args[0], 321);
});

test('AMBÍGUO: dois cartões abertos no telefone — não vincula, não aceita, não escreve; fica à vista na tela', async () => {
  for (const modo of ['recente', 'estoque'] as const) {
    const k = kommoFalso({
      caixa: [lead('u-a', modo === 'recente' ? 10 : 600, 1)],
      contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001] }, { id: 2, telefones: [FONE], leadIds: [321, 322] }],
      cartoes: [cartao(321), cartao(322, AGENDADO)],
    });
    const { c, simulacoes } = ctx({ estoque: 'ligado' });
    const r = await rodarConta(k.porta, c);
    assert.equal(r.ambiguos, 1, modo);
    assert.deepEqual(k.escritas, [], `${modo}: nada escrito`);
    assert.equal(simulacoes.length, 1);
    assert.equal(simulacoes[0].acao, 'pularia');
    assert.equal(simulacoes[0].valor, '321, 322');
    assert.equal(simulacoes[0].automacao, modo === 'recente' ? ID_ENTRADA : ID_ESTOQUE);
  }
});

test('SEM PAR e recente: aceita, na primeira etapa de trabalho do funil DO LEAD (pula a etapa de entrada)', async () => {
  const k = kommoFalso({ caixa: [lead('u-a', 10, 1)], contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001] }], cartoes: [] });
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  assert.equal(r.aceitos, 1);
  const aceite = k.escritas.find((e) => e.tipo === 'aceitar');
  assert.deepEqual(aceite?.args, ['u-a', QUALIFICACAO], 'EM QUALIFICAÇÃO, não a etapa de entrada nem o AGENDADO');
  assert.ok(!k.escritas.some((e) => e.tipo === 'vincular'));
});

test('SEM PAR e velho: NÃO aceita (nem com o estoque ligado) — só aparece na tela para decisão humana', async () => {
  const k = kommoFalso({ caixa: [lead('u-a', 60 * 24 * 30, 1)], contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001] }], cartoes: [] });
  const { c, simulacoes } = ctx({ recente: 'ligado', estoque: 'ligado' });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.aceitos, 0);
  assert.equal(r.semParVelho, 1);
  assert.deepEqual(k.escritas, []);
  assert.equal(simulacoes[0].acao, 'pularia');
  assert.match(String(simulacoes[0].motivo), /boas-vindas fora de hora/);
});

test('ESTOQUE: lead velho com UM cartão aberto é vinculado; a automação de recentes desligada não impede', async () => {
  const k = kommoFalso({
    caixa: [lead('u-velho', 60 * 24 * 40, 1)],
    contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001] }, { id: 2, telefones: [FONE], leadIds: [321] }],
    cartoes: [cartao(321)],
  });
  const { c } = ctx({ recente: 'desligado', estoque: 'ligado' });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.vinculados, 1);
  assert.deepEqual(k.escritas.find((e) => e.tipo === 'vincular')?.args, ['u-velho', 321]);
});

test('JANELA: o recente nunca se estende. Lead de 3 h com o estoque desligado não é tocado; o de 1 min espera; o de 119 min ainda é aceito', async () => {
  const k = kommoFalso({
    caixa: [lead('u-3h', 180, 1), lead('u-1min', 1, 2), lead('u-119', 119, 3)],
    contatos: [{ id: 1, telefones: ['47 90000-0001'], leadIds: [] }, { id: 2, telefones: ['47 90000-0002'], leadIds: [] }, { id: 3, telefones: ['47 90000-0003'], leadIds: [] }],
    cartoes: [],
  });
  const { c } = ctx({ recente: 'ligado', estoque: 'desligado' });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.aguardando, 1);
  assert.deepEqual(k.escritas.filter((e) => e.tipo === 'aceitar').map((e) => e.args[0]), ['u-119']);
});

test('SECO não grava: nem vincular, nem aceitar, nem nota — só decide, loga e registra para a tela', async () => {
  const k = kommoFalso({
    caixa: [lead('u-par', 10, 1), lead('u-novo', 20, 5)],
    contatos: [
      { id: 1, telefones: [FONE], leadIds: [5_000_001] },
      { id: 2, telefones: [FONE], leadIds: [321] },
      { id: 5, telefones: ['47 98888-0005'], leadIds: [5_000_005] },
    ],
    cartoes: [cartao(321)],
  });
  const { c, simulacoes } = ctx({ recente: 'seco', estoque: 'seco' });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.vincularia, 1);
  assert.equal(r.aceitaria, 1);
  assert.equal(r.vinculados + r.aceitos, 0);
  assert.deepEqual(k.escritas, [], 'zero escrita no Kommo');
  assert.deepEqual(simulacoes.map((s) => s.acao).sort(), ['gravaria', 'moveria']);
  assert.match(String(simulacoes.find((s) => s.acao === 'moveria')?.alvo), /EM QUALIFICAÇÃO/);
});

test('CATEGORIA: formulário, ligação e e-mail ficam como estão (nem são buscados)', async () => {
  const k = kommoFalso({
    caixa: [lead('u-form', 10, 1, { categoria: 'forms' }), lead('u-sip', 10, 2, { categoria: 'sip' }), lead('u-mail', 10, 3, { categoria: 'mail' })],
    contatos: [],
    cartoes: [],
  });
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  assert.equal(r.foraDeEscopo, 3);
  assert.deepEqual(k.escritas, []);
  assert.ok(!k.chamadas.includes('telefonesDoContato'));
});

test('cartão só FECHADO (PERDIDO) não segura o aceite; o cartão em etapa de entrada e o outro DDD também não contam', async () => {
  const k = kommoFalso({
    caixa: [lead('u-a', 10, 1)],
    contatos: [
      { id: 1, telefones: [FONE], leadIds: [5_000_001] },
      { id: 2, telefones: [FONE], leadIds: [321, 322] },
      { id: 3, telefones: ['11 99917-2442'], leadIds: [323] }, // mesmos 8 dígitos, DDD de São Paulo
    ],
    cartoes: [cartao(321, 143), cartao(322, ENTRADA), cartao(323)],
  });
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  assert.equal(r.aceitos, 1);
  assert.ok(!k.escritas.some((e) => e.tipo === 'vincular'));
});

test('o próprio cartão provisório e os outros leads da caixa nunca são "par"', async () => {
  const k = kommoFalso({
    caixa: [lead('u-a', 10, 1), lead('u-b', 12, 2)],
    contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001, 5_000_002] }, { id: 2, telefones: [FONE], leadIds: [5_000_002] }],
    cartoes: [cartao(5_000_001, ENTRADA), cartao(5_000_002, ENTRADA)],
  });
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  // dois leads de entrada do MESMO telefone e nenhum cartão: aceita UM; o outro espera a rodada seguinte (a busca do Kommo pode demorar a ver o novo)
  assert.equal(r.aceitos, 1);
  assert.equal(r.adiados, 1);
  assert.equal(k.escritas.filter((e) => e.tipo === 'aceitar').length, 1);
  assert.equal(k.escritas.find((e) => e.tipo === 'aceitar')?.args[0], 'u-b', 'o que espera há mais tempo vai primeiro');
});

test('FALHA DA API não perde nada: busca que falha NÃO vira "sem cartão" (não aceita), e a conta descansa', async () => {
  const k = kommoFalso({ caixa: [lead('u-a', 10, 1)], contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001] }], cartoes: [] });
  k.falhar.busca = [true];
  const m = memoriaNova();
  const { c } = ctx({ memoria: m });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.aceitos, 0);
  assert.equal(r.erros, 1);
  assert.match(String(r.encerrouCedo), /busca por telefone falhou/);
  assert.deepEqual(k.escritas, []);
  assert.ok(m.bloqueadaAte > Date.now() && m.bloqueadaAte <= Date.now() + DESCANSO_CURTO_MS);
  // em descanso: a rodada seguinte nem chama o Kommo
  const antes = k.chamadas.length;
  const r2 = await rodarConta(k.porta, c);
  assert.match(String(r2.encerrouCedo), /descanso/);
  assert.equal(k.chamadas.length, antes);
  // passado o descanso, o lead ainda está lá e é tratado
  m.bloqueadaAte = 0;
  const r3 = await rodarConta(k.porta, c);
  assert.equal(r3.aceitos, 1);
});

test('FALHA ao vincular (500): o lead fica na caixa, a rodada para; na rodada seguinte o vínculo sai', async () => {
  const k = kommoFalso({
    caixa: [lead('u-a', 10, 1)],
    contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001] }, { id: 2, telefones: [FONE], leadIds: [321] }],
    cartoes: [cartao(321)],
  });
  k.falhar.vincular = [new KommoApiError('vincular', 500, {})];
  const m = memoriaNova();
  const { c } = ctx({ memoria: m });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.vinculados, 0);
  assert.equal(r.erros, 1);
  assert.deepEqual(k.escritas, []);
  assert.equal(m.vistoAte.size, 0, 'erro que passa NÃO marca o lead como visto: tenta de novo');
  m.bloqueadaAte = 0;
  const r2 = await rodarConta(k.porta, c);
  assert.equal(r2.vinculados, 1);
});

test('404 ao aceitar = alguém já tratou (a recepção ou a Sofia): conta como já resolvido, não como erro, e segue para o próximo', async () => {
  const k = kommoFalso({
    caixa: [lead('u-a', 10, 1), lead('u-b', 11, 2)],
    contatos: [{ id: 1, telefones: ['47 90000-0001'], leadIds: [] }, { id: 2, telefones: ['47 90000-0002'], leadIds: [] }],
    cartoes: [],
  });
  k.falhar.aceitar = [new KommoApiError('aceitar', 404, {})];
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  assert.equal(r.jaResolvidos, 1);
  assert.equal(r.erros, 0);
  assert.equal(r.aceitos, 1);
});

test('403 três vezes seguidas (token sem direito de admin): a conta descansa 1 hora em vez de bater de 3 em 3 minutos', async () => {
  const caixa = [1, 2, 3, 4, 5].map((n) => lead(`u-${n}`, 10 + n, n));
  const contatos = [1, 2, 3, 4, 5].flatMap((n) => [
    { id: n, telefones: [`47 9000${n}-0000`], leadIds: [5_000_000 + n] },
    { id: 100 + n, telefones: [`47 9000${n}-0000`], leadIds: [300 + n] },
  ]);
  const k = kommoFalso({ caixa, contatos, cartoes: [1, 2, 3, 4, 5].map((n) => cartao(300 + n)) });
  k.falhar.vincular = [1, 2, 3, 4, 5].map(() => new KommoApiError('vincular', 403, {}));
  const m = memoriaNova();
  const { c } = ctx({ memoria: m });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.erros, 3);
  assert.match(String(r.encerrouCedo), /três erros/);
  assert.ok(m.bloqueadaAte > Date.now() + BLOQUEIO_MS - 5000);
  assert.deepEqual(k.escritas, []);
});

test('falha ao LER a caixa: nada é feito e nada é perdido', async () => {
  const k = kommoFalso({ caixa: [lead('u-a', 10, 1)], contatos: [], cartoes: [] });
  k.falhar.listarEntrada = [new KommoApiError('lista', 502, {})];
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  assert.equal(r.erros, 1);
  assert.match(String(r.encerrouCedo), /não consegui ler/);
  assert.deepEqual(k.escritas, []);
});

test('TETO: 5 leads sem par, teto de 2 avaliações = só 2 aceitos; os outros entram na rodada seguinte (o mais velho primeiro)', async () => {
  const caixa = [1, 2, 3, 4, 5].map((n) => lead(`u-${n}`, 10 + n, n));
  const contatos = [1, 2, 3, 4, 5].map((n) => ({ id: n, telefones: [`47 9000${n}-0000`], leadIds: [5_000_000 + n] }));
  const k = kommoFalso({ caixa, contatos, cartoes: [] });
  const m = memoriaNova();
  const { c } = ctx({ cfg: { ...CFG, maxAvaliacoes: 2 }, memoria: m });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.avaliados, 2);
  assert.deepEqual(k.escritas.filter((e) => e.tipo === 'aceitar').map((e) => e.args[0]), ['u-5', 'u-4'], 'os que esperam há mais tempo');
});

test('TETO de escritas: no papel conta igual — o que o João confere é o que ligado faria', async () => {
  const caixa = [1, 2, 3].map((n) => lead(`u-${n}`, 10 + n, n));
  const contatos = [1, 2, 3].map((n) => ({ id: n, telefones: [`47 9000${n}-0000`], leadIds: [5_000_000 + n] }));
  const k = kommoFalso({ caixa, contatos, cartoes: [] });
  const { c } = ctx({ recente: 'seco', cfg: { ...CFG, maxEscritas: 2 } });
  const r = await rodarConta(k.porta, c);
  assert.equal(r.aceitaria, 2);
});

test('o recente vem antes do estoque: com teto apertado o estoque nunca atrasa quem acabou de chegar', async () => {
  const k = kommoFalso({
    caixa: [lead('u-velho', 60 * 24, 1), lead('u-novo', 10, 2)],
    contatos: [{ id: 1, telefones: ['47 90000-0001'], leadIds: [] }, { id: 2, telefones: ['47 90000-0002'], leadIds: [] }],
    cartoes: [],
  });
  const { c } = ctx({ recente: 'ligado', estoque: 'ligado', cfg: { ...CFG, maxAvaliacoes: 1 } });
  await rodarConta(k.porta, c);
  assert.deepEqual(k.escritas.filter((e) => e.tipo === 'aceitar').map((e) => e.args[0]), ['u-novo']);
});

test('já visto: o ambíguo não é buscado de novo a cada 3 minutos; trocar de "só no papel" para ligado reavalia', async () => {
  const k = kommoFalso({
    caixa: [lead('u-a', 10, 1)],
    contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001] }, { id: 2, telefones: [FONE], leadIds: [321] }],
    cartoes: [cartao(321)],
  });
  const m = memoriaNova();
  const r1 = await rodarConta(k.porta, ctx({ recente: 'seco', memoria: m }).c);
  assert.equal(r1.vincularia, 1);
  const buscas = k.chamadas.filter((x) => x === 'buscarContatos').length;
  const r2 = await rodarConta(k.porta, ctx({ recente: 'seco', memoria: m }).c);
  assert.equal(r2.jaVistos, 1);
  assert.equal(k.chamadas.filter((x) => x === 'buscarContatos').length, buscas, 'nenhuma busca nova');
  const r3 = await rodarConta(k.porta, ctx({ recente: 'ligado', memoria: m }).c);
  assert.equal(r3.vinculados, 1, 'ligado reavalia: o "visto" do seco não vale');
});

test('busca devolvendo o teto (50 contatos) não prova nada: não aceita, não vincula', async () => {
  const muitos = Array.from({ length: 50 }, (_, n) => ({ id: 1000 + n, telefones: [FONE], leadIds: [] as number[] }));
  const k = kommoFalso({ caixa: [lead('u-a', 10, 1)], contatos: [{ id: 1, telefones: [FONE], leadIds: [5_000_001] }, ...muitos], cartoes: [] });
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  assert.deepEqual(k.escritas, []);
  assert.equal(r.aceitos, 0);
});

test('contato sem telefone: não dá para saber se já existe cartão — não aceita', async () => {
  const k = kommoFalso({ caixa: [lead('u-a', 10, 1)], contatos: [{ id: 1, telefones: [], leadIds: [] }], cartoes: [] });
  const { c } = ctx();
  const r = await rodarConta(k.porta, c);
  assert.equal(r.semTelefone, 1);
  assert.deepEqual(k.escritas, []);
});

test('tudo desligado: nem lê a caixa', async () => {
  const k = kommoFalso({ caixa: [lead('u-a', 10, 1)], contatos: [], cartoes: [] });
  const { c } = ctx({ recente: 'desligado', estoque: 'desligado' });
  await rodarConta(k.porta, c);
  assert.deepEqual(k.chamadas, []);
});

// ─── o worker e o catálogo ────────────────────────────────────────────────────────────────────────

test('estado da conta: quem está desligado não conta; qualquer "só no papel" entre os que ligaram segura a conta no papel', () => {
  assert.equal(estadoDaConta([]), 'desligado');
  assert.equal(estadoDaConta(['desligado', 'desligado']), 'desligado');
  assert.equal(estadoDaConta(['ligado', 'desligado']), 'ligado');
  assert.equal(estadoDaConta(['ligado', 'seco']), 'seco');
  assert.equal(estadoDaConta(['seco']), 'seco');
});

test('agrupar por conta: o subdomínio manda (maiúscula não separa); unidade sem token não entra', () => {
  const u = (slug: string, sub: string | null, token: string | null) => ({ slug, kommoSubdomain: sub, kommoAccessToken: token });
  const g = agruparPorConta([u('b', 'Timbosc', 't'), u('a', 'timbosc', 't'), u('c', 'outra', 't'), u('d', 'timbosc', null), u('e', null, 't')]);
  assert.deepEqual([...g.keys()].sort(), ['outra', 'timbosc']);
  assert.deepEqual(g.get('timbosc')?.map((x) => x.slug), ['a', 'b']);
});

test('catálogo: as duas chaves existem, nascem desligadas, têm modo seco e exigem o seco antes', () => {
  assert.deepEqual(verificarCatalogo(), []);
  for (const [id, chave] of [[ID_ENTRADA, 'ENTRADA_AUTOMATICA_SLUGS'], [ID_ESTOQUE, 'ENTRADA_ESTOQUE_SLUGS']] as const) {
    const a = automacaoPorId(id);
    assert.ok(a, id);
    assert.equal(automacaoPorChave(chave)?.id, id);
    assert.equal(a.quandoVazio, 'desligado');
    assert.equal(a.temSeco, true);
    assert.equal(a.exigeSecoAntes, true);
    assert.equal(a.risco, 'move-cartao');
  }
  assert.ok(AUTOMACOES.some((a) => a.id === ID_ESTOQUE));
});

// ─── o cliente do Kommo: o que vai pela rede ──────────────────────────────────────────────────────

const UNIT = {
  kommoSubdomain: 'timbosc', kommoAccessToken: 't', kommoSalesbotId: null, kommoReplyFieldId: null,
  kommoBypassSalesbot: false, kommoSalesbotExecuteEnabled: false,
} as never;

function redeFalsa(resposta: (config: InternalAxiosRequestConfig, n: number) => { status: number; corpo?: unknown }) {
  const pedidos: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    pedidos.push(config);
    const { status, corpo } = resposta(config, pedidos.length);
    const response = { data: corpo ?? '', status, statusText: '', headers: {}, config };
    if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, response);
    return response;
  };
  return { adapter, pedidos };
}

const bruto = (n: number, uid = 'x') => ({
  uid: `${uid}${n}`, pipeline_id: FUNIL, category: 'chats', created_at: AGORA - n,
  _embedded: { leads: [{ id: 100 + n }], contacts: [{ id: 200 + n }] },
});

test('cliente: listarEntrada pede só chats, do mais novo ao mais velho, página a página, e lê uid/funil/lead/contato', async () => {
  const rede = redeFalsa((cfg) => {
    const page = (cfg.params as { page: number }).page;
    return { status: 200, corpo: { _embedded: { unsorted: page === 1 ? Array.from({ length: 250 }, (_, n) => bruto(n)) : [bruto(999, 'ultimo'), { uid: '', created_at: 1 }, { category: 'chats' }] } } };
  });
  const kommo = createKommoClientSemFreio(UNIT, { adapter: rede.adapter });
  const r = await kommo.listarEntrada({ categoria: 'chats' });
  assert.equal(r.completa, true);
  assert.equal(r.itens.length, 251, 'o item sem uid ou sem data é ignorado');
  assert.deepEqual(r.itens[250], { uid: 'ultimo999', pipelineId: FUNIL, categoria: 'chats', criadoEm: AGORA - 999, leadId: 1099, contatoId: 1199 });
  const p = rede.pedidos[0].params as Record<string, unknown>;
  assert.equal(p['filter[category][]'], 'chats');
  assert.equal(p['order[created_at]'], 'desc');
  assert.equal(p.limit, 250);
  assert.equal(rede.pedidos[0].url, '/leads/unsorted');
});

test('cliente: listarEntrada — caixa vazia (204) é lista vazia; erro do Kommo LANÇA (nunca vira "caixa vazia"); teto de páginas = incompleta', async () => {
  const vazia = createKommoClientSemFreio(UNIT, { adapter: redeFalsa(() => ({ status: 204 })).adapter });
  assert.deepEqual(await vazia.listarEntrada(), { itens: [], completa: true });
  const quebrada = createKommoClientSemFreio(UNIT, { adapter: redeFalsa(() => ({ status: 500 })).adapter });
  await assert.rejects(() => quebrada.listarEntrada(), (e: unknown) => e instanceof KommoApiError && e.status === 500);
  const cheia = createKommoClientSemFreio(UNIT, { adapter: redeFalsa(() => ({ status: 200, corpo: { _embedded: { unsorted: Array.from({ length: 250 }, (_, n) => bruto(n)) } } })).adapter });
  const r = await cheia.listarEntrada({ maxPaginas: 2 });
  assert.equal(r.itens.length, 500);
  assert.equal(r.completa, false);
});

test('cliente: vincular manda {link:{entity_id, entity_type:"leads"}} e aceitar manda só o status_id — nada de user_id nem etapa no vincular', async () => {
  const rede = redeFalsa((cfg) => (cfg.url?.endsWith('/accept') ? { status: 200, corpo: { _embedded: { leads: [{ id: 777 }] } } } : { status: 200, corpo: { _embedded: { leads: [{ id: 321 }] } } }));
  const kommo = createKommoClientSemFreio(UNIT, { adapter: rede.adapter });
  await kommo.vincularEntrada('abc/def', 321);
  const r = await kommo.aceitarEntrada('abc', QUALIFICACAO);
  assert.equal(rede.pedidos[0].method, 'post');
  assert.equal(rede.pedidos[0].url, '/leads/unsorted/abc%2Fdef/link');
  assert.deepEqual(JSON.parse(rede.pedidos[0].data), { link: { entity_id: 321, entity_type: 'leads' } });
  assert.equal(rede.pedidos[1].url, '/leads/unsorted/abc/accept');
  assert.deepEqual(JSON.parse(rede.pedidos[1].data), { status_id: QUALIFICACAO });
  assert.deepEqual(r, { leadId: 777 });
});

test('cliente: 403 de vincular (token sem admin) lança com o status, e telefonesDoContato lê o PHONE', async () => {
  const kommo = createKommoClientSemFreio(UNIT, {
    adapter: redeFalsa((cfg) =>
      cfg.url?.includes('/link')
        ? { status: 403, corpo: { title: 'Forbidden' } }
        : { status: 200, corpo: { custom_fields_values: [{ field_code: 'EMAIL', values: [{ value: 'a@b.c' }] }, { field_code: 'PHONE', values: [{ value: ' +5547999172442 ' }, { value: '' }] }] } },
    ).adapter,
  });
  await assert.rejects(() => kommo.vincularEntrada('u', 1), (e: unknown) => e instanceof KommoApiError && e.status === 403 && classeDoErro(e) === 'permanente');
  assert.deepEqual(await kommo.telefonesDoContato(9), ['+5547999172442']);
});
