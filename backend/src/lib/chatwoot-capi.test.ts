/**
 * Conversões do Chatwoot para a Meta com portas falsas (sem banco, sem rede, sem Meta de verdade): cada evento por mudança de etapa,
 * lead sem clique de anúncio = nada, nunca repete, seco não chama a Meta, sem token/dataset não chama e avisa uma vez.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { logger } from './logger.js';
import { automacaoPorId, verificarCatalogo } from './automacoes.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { criarContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import {
  _limparAvisosParaTeste,
  CAIXAS_CAPI,
  chatDoCapi,
  cicloDoCapi,
  cliqueDasMensagens,
  configDaUnidade,
  eventosAlcancados,
  JANELA_DA_META_MS,
  MAX_ENVIOS_POR_CICLO,
  MAX_TENTATIVAS,
  metaDaGraph,
  montarEvento,
  sufixoDaUnidade,
  type ArmazemCapi,
  type CliqueDoAnuncio,
  type ConfigDaUnidade,
  type DepsDoCapi,
  type LinhaCapi,
  type PortaDaMeta,
  type ResultadoDaMeta,
} from './chatwoot-capi.js';

const CAIXA = 3;
const SLUG = 'doutor-hernia-parauapebas';
const WABA = '2146287749563217';
const T0 = new Date('2026-11-16T15:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const unix = (s: string) => Math.floor(new Date(s).getTime() / 1000);
function bruta(id: number, attrs: Record<string, unknown>, o: { nome?: string; fone?: string } = {}) {
  return {
    id,
    created_at: unix('2026-11-01T12:00:00Z'),
    labels: [],
    custom_attributes: attrs,
    meta: { sender: { name: o.nome ?? 'Maria da Silva', phone_number: o.fone ?? '+5594999990000' } },
    last_non_activity_message: null,
  };
}

function armazemFalso() {
  const linhas: Array<LinhaCapi & { caixa: number }> = [];
  const armazem: ArmazemCapi = {
    async linhas() {
      return linhas.map((l) => ({ ...l }));
    },
    async registrar(l) {
      if (linhas.some((x) => x.conversationId === l.conversationId && x.regra === l.regra && x.chave === l.chave)) return false;
      linhas.push({ ...l });
      return true;
    },
    async desfazer(conversationId, regra, chave) {
      const i = linhas.findIndex((x) => x.conversationId === conversationId && x.regra === regra && x.chave === chave);
      if (i >= 0) linhas.splice(i, 1);
    },
    async marcar(conversationId, regra, chave, modo) {
      const l = linhas.find((x) => x.conversationId === conversationId && x.regra === regra && x.chave === chave);
      if (l) l.modo = modo;
    },
  };
  return { armazem, linhas };
}

interface Cenario {
  /** as conversas da caixa agora */
  conversas: unknown[];
  /** clique por conversa; ausente = lead orgânico */
  cliques?: Record<number, CliqueDoAnuncio>;
  resultados?: ResultadoDaMeta[]; // respostas em ordem; depois disso, ok
  config?: Partial<ConfigDaUnidade>;
  dataset?: string | null | Error;
}

function montar(c: Cenario) {
  const { armazem, linhas } = armazemFalso();
  const estado = { conversas: c.conversas, cliques: c.cliques ?? {}, resultados: [...(c.resultados ?? [])], config: c.config };
  const buscasDeClique: number[] = [];
  const enviados: Array<{ dataset: string; token: string; evento: Record<string, any> }> = [];
  const datasets: string[] = [];
  const meta: PortaDaMeta = {
    async dataset(waba) {
      datasets.push(waba);
      if (c.dataset instanceof Error) throw c.dataset;
      return c.dataset === undefined ? 'DS-1' : c.dataset;
    },
    async enviar(dataset, token, evento) {
      enviados.push({ dataset, token, evento: evento as Record<string, any> });
      return estado.resultados.shift() ?? { tipo: 'ok' };
    },
  };
  const deps: DepsDoCapi = {
    armazem,
    meta,
    chat: {
      async pagina(_caixa, pagina) {
        return estado.conversas.slice((pagina - 1) * 25, pagina * 25);
      },
      async clique(id) {
        buscasDeClique.push(id);
        return estado.cliques[id] ?? null;
      },
    },
    config: () => ({ token: 'TOKEN-SECRETO', datasetId: null, valorDoFechamento: 3500, ...estado.config }),
    pausa: async () => undefined,
  };
  const ciclo = (modo: 'seco' | 'ligado', quando: Date) => cicloDoCapi(deps, CAIXA, SLUG, WABA, modo, quando);
  return { deps, estado, linhas, enviados, datasets, buscasDeClique, ciclo };
}

const CLIQUE: CliqueDoAnuncio = { ctwaClid: 'ARAk-clid-1', anuncio: '120210000000001' };

// ── a decisão ───────────────────────────────────────────────────────────────────────────────────────

test('catálogo: a automação existe, tem seco, exige seco antes e a caixa é a mesma unidade da régua', () => {
  const a = automacaoPorId('chatwoot-capi');
  assert.ok(a);
  assert.equal(a!.temSeco, true);
  assert.equal(a!.exigeSecoAntes, true);
  assert.equal(a!.quandoVazio, 'desligado');
  assert.equal(a!.risco, 'manda-dado-externo');
  assert.deepEqual(verificarCatalogo(), []);
  assert.equal(CAIXAS_CAPI[CAIXA]!.slug, CAIXAS_REGUA[CAIXA]);
});

test('eventos: Agendado/Confirmado = AddToCart; Compareceu/Atendido = InitiateCheckout; Fechou/«Fechou tratamento» = Purchase', () => {
  assert.deepEqual(eventosAlcancados({ etapa: 'Agendado' }), ['AddToCart']);
  assert.deepEqual(eventosAlcancados({ etapa: 'Confirmado' }), ['AddToCart']);
  assert.deepEqual(eventosAlcancados({ etapa: 'confirmado ' }), ['AddToCart']);
  assert.deepEqual(eventosAlcancados({ etapa: 'Compareceu' }), ['InitiateCheckout']);
  assert.deepEqual(eventosAlcancados({ etapa: 'Esperando humano', situacao_consulta: 'Atendido' }), ['InitiateCheckout']);
  assert.deepEqual(eventosAlcancados({ etapa: 'Fechou' }), ['Purchase']);
  assert.deepEqual(eventosAlcancados({ etapa: 'Pós-consulta', fechou_tratamento: 'sim' }), ['Purchase']);
  assert.deepEqual(eventosAlcancados({ etapa: 'Pós-consulta', fechou_tratamento: true }), ['Purchase']);
  assert.deepEqual(eventosAlcancados({ etapa: 'Compareceu', fechou_tratamento: 'Sim' }), ['InitiateCheckout', 'Purchase']);
  for (const etapa of ['Novo lead', 'Sofia qualifica', 'Esperando humano', 'Pós-consulta', 'Resgate', 'Perdido', 'Frio', '']) assert.deepEqual(eventosAlcancados({ etapa }), []);
  assert.deepEqual(eventosAlcancados({ etapa: 'Agendado', situacao_consulta: 'Não compareceu', fechou_tratamento: 'não' }), ['AddToCart']);
});

test('formato do evento: nomes e campos da Conversions API for Business Messaging; contato só com sha256', () => {
  const e = montarEvento({
    evento: 'Purchase', conversationId: 77, eventTime: 1_700_000_000, waba: WABA, ctwaClid: 'ARAk-x', telefone: '+55 (94) 99999-0000', nome: 'Maria  da Silva', valorDoFechamento: 3500,
  }) as Record<string, any>;
  assert.equal(e.event_name, 'Purchase');
  assert.equal(e.event_time, 1_700_000_000);
  assert.equal(e.event_id, 'chatwoot-77-Purchase');
  assert.equal(e.action_source, 'business_messaging');
  assert.equal(e.messaging_channel, 'whatsapp');
  assert.equal(e.user_data.whatsapp_business_account_id, WABA);
  assert.equal(e.user_data.ctwa_clid, 'ARAk-x');
  assert.deepEqual(e.user_data.ph, [sha('5594999990000')]);
  assert.deepEqual(e.user_data.external_id, [sha('5594999990000')]);
  assert.deepEqual(e.user_data.country, [sha('br')]);
  assert.deepEqual(e.user_data.fn, [sha('maria')]);
  assert.deepEqual(e.user_data.ln, [sha('silva')]);
  assert.deepEqual(e.custom_data, { currency: 'BRL', value: 3500 });
  assert.equal(JSON.stringify(e).includes('9999-0000'), false);
  // só o fechamento leva valor; telefone fora do padrão não vira hash
  const a = montarEvento({ evento: 'AddToCart', conversationId: 1, eventTime: 1, waba: WABA, ctwaClid: 'c', telefone: '123', valorDoFechamento: 3500 }) as Record<string, any>;
  assert.equal(a.custom_data, undefined);
  assert.equal(a.user_data.ph, undefined);
  assert.equal(a.user_data.fn, undefined);
});

test('clique: a 1ª mensagem RECEBIDA com referral; mensagem enviada ou sem ctwa_clid não conta', () => {
  const msgs = [
    { id: 30, message_type: 0, created_at: 300, content_attributes: { referral: { ctwa_clid: 'SEGUNDO', source_id: '2' } } },
    { id: 10, message_type: 1, created_at: 100, content_attributes: { referral: { ctwa_clid: 'ENVIADA', source_id: '9' } } },
    { id: 20, message_type: 0, created_at: 200, content_attributes: { referral: { ctwa_clid: 'PRIMEIRO', source_id: 120210000000001 } } },
    { id: 5, message_type: 0, created_at: 50, content_attributes: { referral: { source_id: '3' } } },
    { id: 6, message_type: 0, created_at: 60, content_attributes: {} },
  ];
  assert.deepEqual(cliqueDasMensagens(msgs), { ctwaClid: 'PRIMEIRO', anuncio: '120210000000001' });
  assert.equal(cliqueDasMensagens([{ id: 1, message_type: 0, created_at: 1, content_attributes: {} }]), null);
  assert.equal(cliqueDasMensagens([]), null);
});

// ── o ciclo ─────────────────────────────────────────────────────────────────────────────────────────

test('cada evento sai quando a conversa ENTRA na etapa: Agendado → AddToCart, Compareceu → InitiateCheckout, Fechou → Purchase', async () => {
  const t = montar({ conversas: [bruta(10, { etapa: 'Novo lead' })], cliques: { 10: CLIQUE } });
  const r1 = await t.ciclo('ligado', T0);
  assert.equal(r1.primeiraVez, true);
  assert.equal(t.enviados.length, 0);

  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  const r2 = await t.ciclo('ligado', min(10));
  assert.equal(r2.enviados, 1);
  assert.equal(t.enviados.length, 1);
  assert.equal(t.enviados[0]!.dataset, 'DS-1');
  assert.equal(t.enviados[0]!.token, 'TOKEN-SECRETO');
  const e1 = t.enviados[0]!.evento;
  assert.equal(e1.event_name, 'AddToCart');
  assert.equal(e1.event_time, Math.floor(min(10).getTime() / 1000));
  assert.equal(e1.user_data.ctwa_clid, CLIQUE.ctwaClid);
  assert.equal(e1.user_data.whatsapp_business_account_id, WABA);

  t.estado.conversas = [bruta(10, { etapa: 'Compareceu' })];
  await t.ciclo('ligado', min(20));
  assert.equal(t.enviados[1]!.evento.event_name, 'InitiateCheckout');

  t.estado.conversas = [bruta(10, { etapa: 'Fechou', fechou_tratamento: 'sim' })];
  await t.ciclo('ligado', min(30));
  assert.equal(t.enviados[2]!.evento.event_name, 'Purchase');
  assert.deepEqual(t.enviados[2]!.evento.custom_data, { currency: 'BRL', value: 3500 });
  assert.equal(t.enviados.length, 3);
  // o clique foi lido UMA vez para a conversa toda
  assert.deepEqual(t.buscasDeClique, [10]);
});

test('as outras formas de chegar no evento: Confirmado, consulta Atendida e «Fechou tratamento»', async () => {
  const t = montar({
    conversas: [bruta(1, {}), bruta(2, {}), bruta(3, { etapa: 'Pós-consulta' })],
    cliques: { 1: CLIQUE, 2: { ctwaClid: 'c2', anuncio: null }, 3: { ctwaClid: 'c3', anuncio: '3' } },
  });
  await t.ciclo('ligado', T0);
  t.estado.conversas = [bruta(1, { etapa: 'Confirmado' }), bruta(2, { etapa: 'Esperando humano', situacao_consulta: 'Atendido' }), bruta(3, { etapa: 'Pós-consulta', fechou_tratamento: 'sim' })];
  await t.ciclo('ligado', min(10));
  const pares = t.enviados.map((e) => `${e.evento.event_id}`).sort();
  assert.deepEqual(pares, ['chatwoot-1-AddToCart', 'chatwoot-2-InitiateCheckout', 'chatwoot-3-Purchase']);
});

test('sem ctwa_clid (lead orgânico): não manda nada, e não relê as mensagens a cada ciclo', async () => {
  const t = montar({ conversas: [bruta(10, { etapa: 'Novo lead' })], cliques: {} });
  await t.ciclo('ligado', T0);
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  const r = await t.ciclo('ligado', min(10));
  assert.equal(r.semClique, 1);
  assert.equal(t.enviados.length, 0);
  assert.equal(t.datasets.length, 0);
  t.estado.conversas = [bruta(10, { etapa: 'Fechou' })];
  await t.ciclo('ligado', min(20));
  await t.ciclo('ligado', min(30));
  assert.equal(t.enviados.length, 0);
  assert.deepEqual(t.buscasDeClique, [10]);
});

test('nunca repete: a mesma conversa e o mesmo evento só saem uma vez, em quantos ciclos forem', async () => {
  const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE } });
  await t.ciclo('ligado', T0);
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  for (let i = 1; i <= 5; i++) await t.ciclo('ligado', min(10 * i));
  assert.equal(t.enviados.length, 1);
  // etapa vai e volta: não é «entrada» nova, não repete
  t.estado.conversas = [bruta(10, { etapa: 'Esperando humano' })];
  await t.ciclo('ligado', min(70));
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  await t.ciclo('ligado', min(80));
  assert.equal(t.enviados.length, 1);
});

test('duas cópias do servidor: quem perde a corrida pela linha não manda', async () => {
  const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE } });
  await t.ciclo('ligado', T0);
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  const registrarOriginal = t.deps.armazem.registrar;
  // a outra cópia grava a trava `capi:AddToCart` um instante antes
  t.deps.armazem.registrar = async (l) => {
    if (l.regra === 'capi:AddToCart') {
      await registrarOriginal({ ...l });
      return false;
    }
    return registrarOriginal(l);
  };
  await t.ciclo('ligado', min(10));
  assert.equal(t.enviados.length, 0);
});

test('o que já estava no estado na 1ª varredura é «inicial» e NUNCA vai (nem depois, nem ligando)', async () => {
  const t = montar({ conversas: [bruta(1, { etapa: 'Fechou' }), bruta(2, { etapa: 'Agendado' })], cliques: { 1: CLIQUE, 2: CLIQUE } });
  const r = await t.ciclo('seco', T0);
  assert.equal(r.primeiraVez, true);
  await t.ciclo('ligado', min(10));
  await t.ciclo('ligado', min(20));
  assert.equal(t.enviados.length, 0);
  assert.equal(t.buscasDeClique.length, 0);
  // uma conversa NOVA que chega depois entra normalmente
  t.estado.conversas = [...t.estado.conversas, bruta(3, { etapa: 'Agendado' })];
  t.estado.cliques[3] = CLIQUE;
  await t.ciclo('ligado', min(30));
  assert.deepEqual(t.enviados.map((e) => e.evento.event_id), ['chatwoot-3-AddToCart']);
});

test('seco: registra e loga «enviaria…», uma vez, e não chama a Meta (nem o dataset); ligado depois manda o que o papel viu', async () => {
  const info = mock.method(logger, 'info', () => undefined);
  try {
    const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE } });
    await t.ciclo('seco', T0);
    t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
    const r = await t.ciclo('seco', min(10));
    await t.ciclo('seco', min(20));
    await t.ciclo('seco', min(30));
    assert.equal(r.seco, 1);
    assert.equal(t.enviados.length, 0);
    assert.equal(t.datasets.length, 0);
    const msgs = info.mock.calls.map((c) => String(c.arguments[1] ?? '')).filter((m) => m.includes('[SECO]'));
    assert.equal(msgs.length, 1);
    assert.match(msgs[0]!, /enviaria evento AddToCart .* para a conversa 10 \(anúncio 120210000000001\)/);
    assert.ok(t.linhas.some((l) => l.regra === 'capi-seco:AddToCart' && l.conversationId === 10));
    assert.equal(t.linhas.some((l) => l.regra === 'capi:AddToCart'), false);
    // ligou: o evento visto no papel (a menos de 7 dias) sai agora, com o horário em que foi visto
    await t.ciclo('ligado', min(60));
    assert.equal(t.enviados.length, 1);
    assert.equal(t.enviados[0]!.evento.event_time, Math.floor(min(10).getTime() / 1000));
  } finally {
    info.mock.restore();
  }
});

test('sem token: não chama a Meta e avisa UMA vez; com o token, o evento sai', async () => {
  _limparAvisosParaTeste();
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE }, config: { token: null } });
    await t.ciclo('ligado', T0);
    t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
    const r = await t.ciclo('ligado', min(10));
    await t.ciclo('ligado', min(20));
    await t.ciclo('ligado', min(30));
    assert.equal(r.interrompido, 'sem token');
    assert.equal(t.enviados.length, 0);
    assert.equal(t.datasets.length, 0);
    const avisos = warn.mock.calls.filter((c) => String(c.arguments[1]).includes('sem token'));
    assert.equal(avisos.length, 1);
    // nada ficou marcado como enviado: quando o token entra, vai
    t.estado.config = { token: 'T' };
    await t.ciclo('ligado', min(40));
    assert.equal(t.enviados.length, 1);
  } finally {
    warn.mock.restore();
  }
});

test('sem dataset (a WABA não tem, ou a Meta não deixou ler): não chama o envio e avisa UMA vez', async () => {
  _limparAvisosParaTeste();
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    for (const dataset of [null, new Error('Meta 403')] as const) {
      _limparAvisosParaTeste();
      warn.mock.resetCalls();
      const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE }, dataset });
      await t.ciclo('ligado', T0);
      t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
      await t.ciclo('ligado', min(10));
      await t.ciclo('ligado', min(20));
      assert.equal(t.enviados.length, 0);
      assert.equal(warn.mock.calls.filter((c) => String(c.arguments[1]).includes('dataset')).length, 1);
    }
  } finally {
    warn.mock.restore();
  }
});

test('dataset fixo por env: não pergunta à Meta qual é', async () => {
  const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE }, config: { datasetId: '999' } });
  await t.ciclo('ligado', T0);
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  await t.ciclo('ligado', min(10));
  assert.equal(t.datasets.length, 0);
  assert.equal(t.enviados[0]!.dataset, '999');
});

test('evento com mais de 7 dias não vai (a Meta recusaria o pedido) e não é tentado de novo', async () => {
  const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE } });
  await t.ciclo('seco', T0);
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  await t.ciclo('seco', min(10)); // visto aqui
  const depois = new Date(min(10).getTime() + JANELA_DA_META_MS + 60_000);
  const r = await t.ciclo('ligado', depois);
  assert.equal(r.expirados, 1);
  assert.equal(t.enviados.length, 0);
  await t.ciclo('ligado', new Date(depois.getTime() + 600_000));
  assert.equal(t.enviados.length, 0);
});

test('a Meta recusa o evento: desfaz a trava e tenta no próximo ciclo; depois do teto, desiste', async () => {
  const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE }, resultados: Array.from({ length: 50 }, () => ({ tipo: 'recusou' as const, detalhe: 'HTTP 400' })) });
  await t.ciclo('ligado', T0);
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  for (let i = 1; i <= MAX_TENTATIVAS + 3; i++) await t.ciclo('ligado', min(10 * i));
  assert.equal(t.enviados.length, MAX_TENTATIVAS);
  assert.equal(t.linhas.find((l) => l.regra === 'capi:AddToCart')?.modo, 'desistiu');
});

test('a Meta recusa uma vez e aceita na seguinte: sai uma vez só', async () => {
  const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE }, resultados: [{ tipo: 'recusou', detalhe: 'HTTP 400' }] });
  await t.ciclo('ligado', T0);
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  const r1 = await t.ciclo('ligado', min(10));
  assert.equal(r1.falhas, 1);
  assert.equal(r1.enviados, 0);
  const r2 = await t.ciclo('ligado', min(20));
  assert.equal(r2.enviados, 1);
  await t.ciclo('ligado', min(30));
  assert.equal(t.enviados.length, 2); // 1 recusado + 1 aceito
  assert.equal(t.linhas.find((l) => l.regra === 'capi:AddToCart')?.modo, 'enviado');
});

test('token recusado ou Meta fora do ar: para o ciclo, não gasta tentativa do evento e tenta no próximo', async () => {
  for (const tipo of ['config', 'transitorio'] as const) {
    const t = montar({ conversas: [bruta(10, {}), bruta(11, {})], cliques: { 10: CLIQUE, 11: CLIQUE }, resultados: [{ tipo, detalhe: 'HTTP 401' }] });
    await t.ciclo('ligado', T0);
    t.estado.conversas = [bruta(10, { etapa: 'Agendado' }), bruta(11, { etapa: 'Agendado' })];
    const r1 = await t.ciclo('ligado', min(10));
    assert.equal(r1.interrompido, tipo);
    assert.equal(t.enviados.length, 1, 'só a 1ª chamada foi feita');
    assert.equal(t.linhas.some((l) => l.regra.startsWith('capi-falha')), false, 'não gastou tentativa');
    await t.ciclo('ligado', min(20));
    assert.deepEqual(t.enviados.map((e) => e.evento.event_id).sort(), ['chatwoot-10-AddToCart', 'chatwoot-10-AddToCart', 'chatwoot-11-AddToCart']);
  }
});

test('sem resposta da Meta (pode ter ido): fica «incerto» e NÃO repete', async () => {
  const error = mock.method(logger, 'error', () => undefined);
  try {
    const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE }, resultados: [{ tipo: 'incerto', detalhe: 'tempo esgotado' }] });
    await t.ciclo('ligado', T0);
    t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
    const r = await t.ciclo('ligado', min(10));
    await t.ciclo('ligado', min(20));
    assert.equal(r.incertos, 1);
    assert.equal(t.enviados.length, 1);
    assert.equal(t.linhas.find((l) => l.regra === 'capi:AddToCart')?.modo, 'incerto');
    assert.equal(error.mock.calls.length, 1);
  } finally {
    error.mock.restore();
  }
});

test('teto de envios por ciclo: o resto fica para o ciclo seguinte, sem perder nem repetir', async () => {
  const n = MAX_ENVIOS_POR_CICLO + 5;
  const ids = Array.from({ length: n }, (_, i) => 100 + i);
  const cliques = Object.fromEntries(ids.map((id) => [id, { ctwaClid: `c${id}`, anuncio: null }]));
  const t = montar({ conversas: ids.map((id) => bruta(id, {})), cliques });
  await t.ciclo('ligado', T0);
  t.estado.conversas = ids.map((id) => bruta(id, { etapa: 'Agendado' }));
  const r1 = await t.ciclo('ligado', min(10));
  assert.equal(r1.enviados, MAX_ENVIOS_POR_CICLO);
  assert.equal(r1.interrompido, 'teto de envios do ciclo');
  await t.ciclo('ligado', min(20));
  assert.equal(t.enviados.length, n);
  assert.equal(new Set(t.enviados.map((e) => e.evento.event_id)).size, n);
});

test('falha ao listar as conversas: o ciclo aborta e não grava nada', async () => {
  const t = montar({ conversas: [] });
  t.deps.chat.pagina = async () => {
    throw new Error('Chatwoot fora do ar');
  };
  await assert.rejects(() => t.ciclo('ligado', T0), /fora do ar/);
  assert.equal(t.linhas.length, 0);
});

test('falha ao ler as mensagens de UMA conversa: as outras seguem e nada fica marcado', async () => {
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    const t = montar({ conversas: [bruta(10, {}), bruta(11, {})], cliques: { 10: CLIQUE, 11: CLIQUE } });
    await t.ciclo('ligado', T0);
    const lerOriginal = t.deps.chat.clique;
    let quebra = true;
    t.deps.chat.clique = async (id) => {
      if (id === 10 && quebra) throw new Error('timeout');
      return lerOriginal(id);
    };
    t.estado.conversas = [bruta(10, { etapa: 'Agendado' }), bruta(11, { etapa: 'Agendado' })];
    const r = await t.ciclo('ligado', min(10));
    assert.equal(r.falhas, 1);
    assert.deepEqual(t.enviados.map((e) => e.evento.event_id), ['chatwoot-11-AddToCart']);
    quebra = false;
    await t.ciclo('ligado', min(20));
    assert.deepEqual(t.enviados.map((e) => e.evento.event_id).sort(), ['chatwoot-10-AddToCart', 'chatwoot-11-AddToCart']);
  } finally {
    warn.mock.restore();
  }
});

// ── a Graph e as env ─────────────────────────────────────────────────────────────────────────────────

const resposta = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
const EVENTO = { event_name: 'Purchase' };

test('Graph: aceita com events_received 1; manda o Bearer e o corpo no formato {data:[evento]}', async () => {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const meta = metaDaGraph((async (url: string, init: RequestInit) => {
    chamadas.push({ url, init });
    return resposta(200, { events_received: 1, messages: [], fbtrace_id: 'x' });
  }) as unknown as typeof fetch);
  const r = await meta.enviar('DS-1', 'TOK', EVENTO);
  assert.equal(r.tipo, 'ok');
  assert.match(chamadas[0]!.url, /\/DS-1\/events$/);
  assert.equal((chamadas[0]!.init.headers as Record<string, string>).Authorization, 'Bearer TOK');
  assert.equal(String(chamadas[0]!.url).includes('TOK'), false);
  assert.deepEqual(JSON.parse(String(chamadas[0]!.init.body)), { data: [EVENTO] });
});

test('Graph: classifica a resposta — token/permissão, instabilidade, recusa, sem confirmação, tempo esgotado — e nunca põe o token no texto', async () => {
  const quando = (f: () => Promise<Response>) => metaDaGraph((async () => f()) as unknown as typeof fetch).enviar('DS', 'TOK-SECRETO', EVENTO);
  assert.equal((await quando(async () => resposta(401, { error: { code: 190, message: 'token TOK-SECRETO inválido' } }))).tipo, 'config');
  assert.equal((await quando(async () => resposta(400, { error: { code: 190, message: 'x' } }))).tipo, 'config');
  assert.equal((await quando(async () => resposta(403, { error: { code: 200, message: 'sem permissão' } }))).tipo, 'config');
  assert.equal((await quando(async () => resposta(500, { error: { message: 'boom' } }))).tipo, 'transitorio');
  assert.equal((await quando(async () => resposta(400, { error: { code: 4, message: 'limite' } }))).tipo, 'transitorio');
  assert.equal((await quando(async () => resposta(400, { error: { code: 100, message: 'ctwa_clid inválido' } }))).tipo, 'recusou');
  assert.equal((await quando(async () => resposta(200, { events_received: 0 }))).tipo, 'incerto');
  assert.equal((await quando(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); })).tipo, 'incerto');
  assert.equal((await quando(async () => { throw new TypeError('fetch failed'); })).tipo, 'transitorio');
  const erro = await quando(async () => resposta(401, { error: { code: 190, message: 'token TOK-SECRETO inválido' } }));
  assert.equal(String(erro.detalhe).includes('TOK-SECRETO'), false);
});

test('Graph: o dataset da WABA vem de {data:[{id}]} ou {id}; recusa vira erro sem o token', async () => {
  const com = (r: () => Response) => metaDaGraph((async () => r()) as unknown as typeof fetch);
  assert.equal(await com(() => resposta(200, { data: [{ id: '123' }] })).dataset(WABA, 'T'), '123');
  assert.equal(await com(() => resposta(200, { id: '456' })).dataset(WABA, 'T'), '456');
  assert.equal(await com(() => resposta(200, { data: [] })).dataset(WABA, 'T'), null);
  await assert.rejects(() => com(() => resposta(403, { error: { message: 'sem acesso T' } })).dataset(WABA, 'T'), (e: Error) => /403/.test(e.message) && !e.message.includes(' T'));
});

test('env: token e dataset por unidade (o mesmo META_ADS_TOKEN_<UNIDADE> do rastreio no n8n)', () => {
  assert.equal(sufixoDaUnidade('doutor-hernia-parauapebas'), 'PARAUAPEBAS');
  assert.equal(sufixoDaUnidade('doutor-hernia-boa-vista'), 'BOA_VISTA');
  const c = configDaUnidade(SLUG, { META_ADS_TOKEN_PARAUAPEBAS: ' abc ', META_DATASET_ID_PARAUAPEBAS: '123', CHATWOOT_CAPI_VALOR_FECHAMENTO: '4200' } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(c, { token: 'abc', datasetId: '123', valorDoFechamento: 4200 });
  assert.equal(configDaUnidade(SLUG, { META_CAPI_TOKEN_PARAUAPEBAS: 'novo', META_ADS_TOKEN_PARAUAPEBAS: 'velho' } as unknown as NodeJS.ProcessEnv).token, 'novo');
  assert.deepEqual(configDaUnidade(SLUG, {} as NodeJS.ProcessEnv), { token: null, datasetId: null, valorDoFechamento: 3500 });
  assert.equal(configDaUnidade(SLUG, { META_DATASET_ID_PARAUAPEBAS: 'abc' } as unknown as NodeJS.ProcessEnv).datasetId, null);
});

test('Chatwoot: lê as mensagens para trás (before) até a primeira e acha o clique', async () => {
  const todas = Array.from({ length: 45 }, (_, i) => ({
    id: i + 1,
    message_type: i === 2 ? 0 : 1,
    created_at: 1000 + i,
    content_attributes: i === 2 ? { referral: { ctwa_clid: 'LA-NO-INICIO', source_id: '777' } } : {},
  }));
  const pedidos: string[] = [];
  const ctx = criarContextoChatwoot(
    { url: 'https://chat.exemplo', conta: 1, token: 't' },
    {
      fetch: (async (url: string) => {
        pedidos.push(String(url));
        const antes = Number(new URL(String(url)).searchParams.get('before')) || Infinity;
        const pagina = todas.filter((m) => m.id < antes).slice(-20);
        return resposta(200, { payload: pagina });
      }) as unknown as typeof fetch,
    },
  );
  const clique = await chatDoCapi(ctx).clique(9);
  assert.deepEqual(clique, { ctwaClid: 'LA-NO-INICIO', anuncio: '777' });
  assert.equal(pedidos.length, 3);
});

test('1ª varredura que falhou numa conversa não vale como partida: o estoque antigo continua «inicial» e nunca vai', async () => {
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    const t = montar({ conversas: [bruta(1, { etapa: 'Fechou' }), bruta(2, { etapa: 'Agendado' })], cliques: { 1: CLIQUE, 2: CLIQUE } });
    const registrarOriginal = t.deps.armazem.registrar;
    let quebra = true;
    t.deps.armazem.registrar = async (l) => {
      if (quebra && l.conversationId === 2) throw new Error('banco piscou');
      return registrarOriginal(l);
    };
    const r1 = await t.ciclo('ligado', T0);
    assert.equal(r1.falhas, 1);
    assert.equal(t.linhas.some((l) => l.regra === 'capi-partida'), false);
    quebra = false;
    const r2 = await t.ciclo('ligado', min(10));
    assert.equal(r2.primeiraVez, true);
    await t.ciclo('ligado', min(20));
    assert.equal(t.enviados.length, 0);
    assert.equal(t.linhas.filter((l) => l.regra === 'capi-partida').length, 1);
  } finally {
    warn.mock.restore();
  }
});

test('token recusado todo ciclo: avisa UMA vez, e o aviso volta quando a Meta voltar a aceitar e falhar de novo', async () => {
  _limparAvisosParaTeste();
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE }, resultados: Array.from({ length: 3 }, () => ({ tipo: 'config' as const, detalhe: 'HTTP 401' })) });
    await t.ciclo('ligado', T0);
    t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
    await t.ciclo('ligado', min(10));
    await t.ciclo('ligado', min(20));
    await t.ciclo('ligado', min(30));
    assert.equal(warn.mock.calls.filter((c) => String(c.arguments[1]).includes('recusou o token')).length, 1);
    await t.ciclo('ligado', min(40)); // 4ª tentativa: a Meta aceita
    assert.equal(t.enviados.length, 4);
    assert.equal(t.linhas.find((l) => l.regra === 'capi:AddToCart')?.modo, 'enviado');
  } finally {
    warn.mock.restore();
  }
});

test('duas caixas: cada uma tem a sua partida (a UNIQUE da tabela não tem a caixa)', async () => {
  const t = montar({ conversas: [bruta(1, { etapa: 'Fechou' })], cliques: { 1: CLIQUE, 2: CLIQUE } });
  await cicloDoCapi(t.deps, 3, SLUG, WABA, 'ligado', T0);
  const r = await cicloDoCapi(t.deps, 5, 'doutor-hernia-outra', '555', 'ligado', min(10));
  assert.equal(r.primeiraVez, true);
  assert.deepEqual(t.linhas.filter((l) => l.regra === 'capi-partida').map((l) => l.conversationId).sort((a, b) => a - b), [-5, -3]);
  const r2 = await cicloDoCapi(t.deps, 5, 'doutor-hernia-outra', '555', 'ligado', min(20));
  assert.equal(r2.primeiraVez, false);
});

test('linha de clique estragada no banco: conta como sem clique, não derruba a conversa', async () => {
  const t = montar({ conversas: [bruta(10, {})], cliques: { 10: CLIQUE } });
  await t.ciclo('ligado', T0);
  await t.deps.armazem.registrar({ caixa: CAIXA, conversationId: 10, regra: 'capi-clique', chave: 'v1', modo: 'com-clique', texto: '{estragado', criadoEm: T0 });
  t.estado.conversas = [bruta(10, { etapa: 'Agendado' })];
  const r = await t.ciclo('ligado', min(10));
  assert.equal(r.falhas, 0);
  assert.equal(r.semClique, 1);
  assert.equal(t.enviados.length, 0);
});

test('Graph: o dataset de uma WABA é lido uma vez só', async () => {
  let n = 0;
  const meta = metaDaGraph((async () => {
    n++;
    return resposta(200, { data: [{ id: '123' }] });
  }) as unknown as typeof fetch);
  assert.equal(await meta.dataset(WABA, 'T'), '123');
  assert.equal(await meta.dataset(WABA, 'T'), '123');
  assert.equal(n, 1);
});

test('sem token: segue anotando a ENTRADA de cada conversa, para o evento sair com o horário certo quando o token chegar', async () => {
  _limparAvisosParaTeste();
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    const t = montar({ conversas: [bruta(10, {}), bruta(11, {})], cliques: { 10: CLIQUE, 11: CLIQUE }, config: { token: null } });
    await t.ciclo('ligado', T0);
    t.estado.conversas = [bruta(10, { etapa: 'Agendado' }), bruta(11, { etapa: 'Agendado' })];
    await t.ciclo('ligado', min(10));
    assert.equal(t.linhas.filter((l) => l.regra === 'capi-visto:AddToCart').length, 2);
    t.estado.config = { token: 'T' };
    await t.ciclo('ligado', min(50));
    assert.equal(t.enviados.length, 2);
    assert.ok(t.enviados.every((e) => e.evento.event_time === Math.floor(min(10).getTime() / 1000)));
  } finally {
    warn.mock.restore();
  }
});
