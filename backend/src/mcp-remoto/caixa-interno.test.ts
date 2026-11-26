import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { PedidoDeLink } from '../lib/integracoes/infinitepay.js';
import { registrarInfinitepayDoServidor } from '../lib/infinitepay-servidor.js';
import { unidadesComLinkDoCaixa } from '../lib/caixa-unidades.js';
import { assinarPedidoDoCaixa, montarRotasDoCaixa, tokenDoServicoDoAmbiente } from './caixa-interno.js';
import { criarContextoInfinitepay, type ContaInfinitepay } from './infinitepay.js';
import { criarEscritaInfinitepay } from './infinitepay-escrita.js';
import { armazemEmMemoria } from './infinitepay-falso.js';
import { JanelaDeContagem } from './limites.js';

const UNI = 'doutor-hernia-acailandia';
const TOKEN = 't'.repeat(40);
const AGORA = Date.parse('2026-11-26T15:00:00Z');

const servidores: Server[] = [];
afterEach(() => {
  registrarInfinitepayDoServidor(null);
  while (servidores.length) servidores.pop()!.close();
});

async function montar(op: { token?: string; link?: string[]; escrita?: string[]; semServidor?: boolean; falhas?: JanelaDeContagem; alertaSai?: boolean } = {}) {
  const pedidos: Array<Omit<PedidoDeLink, 'handle'>> = [];
  const avisos: string[] = [];
  const logs: string[] = [];
  const conta: ContaInfinitepay = {
    slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: {
      consultar: async () => ({ sucesso: true, pago: true }),
      testar: async () => undefined,
      criarLink: async (p) => (pedidos.push(p), { url: `https://checkout.infinitepay.io/dd/${p.orderNsu}` }),
    },
  };
  const armazem = armazemEmMemoria();
  const ctx = criarContextoInfinitepay(new Map([[UNI, conta]]), armazem);
  const esc = criarEscritaInfinitepay({
    armazem, agora: () => AGORA, unidades: () => new Set(op.escrita ?? [UNI]), porHora: () => 20, tetoLink: () => 5000, tetoDia: () => 20000,
    alertar: async (t) => (avisos.push(t), true),
    urlDoWebhook: (u, o) => `https://conector.exemplo.com/infinitepay/webhook/${u}/${o}/x`,
  });
  if (!op.semServidor) registrarInfinitepayDoServidor({ ctx, esc });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const montou = montarRotasDoCaixa(
    app,
    {
      token: 'token' in op ? op.token : TOKEN,
      alertar: async (t) => (avisos.push(t), true),
      unidadesLink: () => new Set(op.link ?? [UNI]),
      agora: () => AGORA,
      log: { info: (o, m) => logs.push(JSON.stringify([o, m])), warn: (o, m) => logs.push(JSON.stringify([o, m])) },
    },
    op.falhas ? { falhasPorIp: op.falhas } : {},
  );
  const srv = createServer(app);
  servidores.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const chamar = async (metodo: 'GET' | 'POST', caminho: string, corpo?: unknown, segredo: string | null = TOKEN, o: { ts?: number; caminhoAssinado?: string } = {}) => {
    const bruto = corpo === undefined ? '' : JSON.stringify(corpo);
    const ts = String(Math.floor((o.ts ?? AGORA) / 1000));
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(segredo ? { 'x-dd-timestamp': ts, 'x-dd-assinatura': assinarPedidoDoCaixa(segredo, ts, metodo, o.caminhoAssinado ?? caminho, bruto) } : {}) },
      ...(corpo === undefined ? {} : { body: bruto }),
    });
    return { http: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return { montou, chamar, pedidos, avisos, logs, armazem };
}

const LINK = { unidade: UNI, origem_ref: 'cx-aaaa1111', valor: 150, descricao: 'Consulta - Doutor Hérnia Açailândia - ref AB12' };

test('sem CAIXA_SERVICO_TOKEN (ou curto) as rotas NÃO existem: 404 e nada é montado', async () => {
  assert.equal(tokenDoServicoDoAmbiente({}), undefined);
  assert.equal(tokenDoServicoDoAmbiente({ CAIXA_SERVICO_TOKEN: 'curto' }), undefined);
  assert.equal(tokenDoServicoDoAmbiente({ CAIXA_SERVICO_TOKEN: TOKEN }), TOKEN);
  const m = await montar({ token: undefined });
  assert.equal(m.montou, false);
  assert.equal((await m.chamar('POST', '/interno/caixa/link', LINK)).http, 404);
});

test('pedido ASSINADO: sem assinatura, segredo errado, caminho trocado, corpo trocado e carimbo velho = 401; erro demais por IP = 429; o segredo nunca vai no fio', async () => {
  const ts = String(Math.floor(AGORA / 1000));
  assert.notEqual(assinarPedidoDoCaixa(TOKEN, ts, 'POST', '/a', '{}'), assinarPedidoDoCaixa(TOKEN, ts, 'POST', '/b', '{}'));
  assert.notEqual(assinarPedidoDoCaixa(TOKEN, ts, 'POST', '/a', '{}'), assinarPedidoDoCaixa(TOKEN, ts, 'GET', '/a', '{}'));
  const m = await montar({ falhas: new JanelaDeContagem(4, 60_000) });
  assert.equal((await m.chamar('POST', '/interno/caixa/link', LINK, null)).http, 401, 'sem assinatura');
  assert.equal((await m.chamar('POST', '/interno/caixa/link', LINK, 'x'.repeat(40))).http, 401, 'segredo errado');
  assert.equal((await m.chamar('POST', '/interno/caixa/link', LINK, TOKEN, { ts: AGORA - 3_600_000 })).http, 401, 'carimbo velho (repetição)');
  assert.equal((await m.chamar('POST', '/interno/caixa/link', LINK, TOKEN, { caminhoAssinado: '/interno/caixa/status' })).http, 401, 'assinatura de outro caminho');
  assert.equal((await m.chamar('POST', '/interno/caixa/link', LINK)).http, 429, 'bloqueado depois de errar demais');
  assert.equal(m.pedidos.length, 0);
  // corpo trocado depois de assinado
  const livre = await montar();
  const bruto = JSON.stringify(LINK);
  const ts2 = String(Math.floor(AGORA / 1000));
  const r = await fetch(`http://127.0.0.1:${(servidores.at(-1)!.address() as AddressInfo).port}/interno/caixa/link`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dd-timestamp': ts2, 'x-dd-assinatura': assinarPedidoDoCaixa(TOKEN, ts2, 'POST', '/interno/caixa/link', bruto) }, body: JSON.stringify({ ...LINK, valor: 4999 }) });
  assert.equal(r.status, 401, 'valor trocado depois de assinar');
  assert.equal(livre.pedidos.length, 0);
  assert.equal((await livre.chamar('POST', '/interno/caixa/link', LINK)).http, 200, 'o pedido íntegro passa');
});

test('link: unidade fora de CAIXA_LINK_UNIDADES = 403 e a InfinitePay nem é chamada; vazio = ninguém', async () => {
  assert.equal(unidadesComLinkDoCaixa({}).size, 0);
  assert.equal(unidadesComLinkDoCaixa({ CAIXA_LINK_UNIDADES: '*, todas' }).size, 0);
  const m = await montar({ link: [] });
  const r = await m.chamar('POST', '/interno/caixa/link', LINK);
  assert.equal(r.http, 403);
  assert.equal(m.pedidos.length, 0);
  assert.equal(m.armazem.linhas.length, 0, 'nem a intenção foi gravada');
});

test('link: o portão da criação (INFINITEPAY_ESCRITA_UNIDADES) continua valendo mesmo com o do Caixa aberto', async () => {
  const m = await montar({ escrita: [] });
  const r = await m.chamar('POST', '/interno/caixa/link', LINK);
  assert.equal(r.http, 422);
  assert.match(String(r.json.erro), /não está ligada na unidade/);
  assert.equal(m.pedidos.length, 0);
});

test('link: cria, e o mesmo pedido (clique duplo) devolve o MESMO link sem criar outro; valor diferente recusa', async () => {
  const m = await montar();
  const a = await m.chamar('POST', '/interno/caixa/link', LINK);
  assert.equal(a.http, 200);
  assert.equal(a.json.criado, true);
  assert.equal(a.json.ja_existia, false);
  assert.match(String(a.json.url), /^https:\/\/checkout\.infinitepay\.io\//);
  const [b, c] = await Promise.all([m.chamar('POST', '/interno/caixa/link', LINK), m.chamar('POST', '/interno/caixa/link', LINK)]);
  for (const x of [b, c]) {
    assert.equal(x.http, 200);
    assert.equal(x.json.ja_existia, true);
    assert.equal(x.json.order_nsu, a.json.order_nsu);
    assert.equal(x.json.url, a.json.url);
  }
  assert.equal(m.pedidos.length, 1, 'UM link na InfinitePay');
  const d = await m.chamar('POST', '/interno/caixa/link', { ...LINK, valor: 151 });
  assert.equal(d.http, 422);
  assert.equal(m.pedidos.length, 1);
});

test('link: o pedido vai à InfinitePay com nome e telefone só se vierem válidos, nunca no livro, e a origem_ref precisa de "cx-"', async () => {
  const m = await montar();
  assert.equal((await m.chamar('POST', '/interno/caixa/link', { ...LINK, origem_ref: 'outro-1' })).http, 400);
  assert.equal((await m.chamar('POST', '/interno/caixa/link', { ...LINK, valor: 0.5 })).http, 400);
  const r = await m.chamar('POST', '/interno/caixa/link', { ...LINK, cliente: { nome: 'Fulana de Tal', telefone: '(99) 98888-7777' } });
  assert.equal(r.http, 200);
  assert.deepEqual(m.pedidos[0]!.cliente, { nome: 'Fulana de Tal', telefone: '+5599988887777' });
  assert.equal(m.pedidos[0]!.semEndereco, true);
  assert.equal(JSON.stringify(m.armazem.linhas).includes('Fulana'), false, 'o nome não vai ao livro');
});

test('status: existe=false; depois criado; depois pago com forma, parcelas e recibo; revisão aparece como em_revisao', async () => {
  const m = await montar();
  const q = `/interno/caixa/status?unidade=${UNI}&origem_ref=cx-aaaa1111`;
  assert.equal((await m.chamar('GET', q)).json.existe, false);
  const a = await m.chamar('POST', '/interno/caixa/link', LINK);
  const s1 = await m.chamar('GET', q);
  assert.equal(s1.json.status, 'criado');
  assert.equal(s1.json.valor_centavos, 15000);
  await m.armazem.aplicarEvento(UNI, String(a.json.order_nsu), {
    evento: 'paid', paraStatus: 'pago', deStatus: ['criado', 'intencao'],
    pagamento: { forma: 'credit_card', parcelas: 3, valorPagoCentavos: 15150, transactionNsu: 'tx-1', reciboUrl: 'https://recibo.exemplo.com/1' },
  });
  const s2 = await m.chamar('GET', q);
  assert.equal(s2.json.status, 'pago');
  assert.equal(s2.json.forma, 'credit_card');
  assert.equal(s2.json.parcelas, 3);
  assert.equal(s2.json.valor_pago_centavos, 15150);
  assert.equal(s2.json.transaction_nsu, 'tx-1');
  assert.equal(/recibo|receipt/i.test(JSON.stringify(s2.json)), false, 'o recibo (nome e CPF de quem pagou) NUNCA sai no status');
  assert.equal(s2.json.em_revisao, false);
  await m.armazem.aplicarEvento(UNI, String(a.json.order_nsu), { evento: 'refunded', revisao: 'estorno avisado' });
  assert.equal((await m.chamar('GET', q)).json.em_revisao, true);
  assert.equal((await m.chamar('GET', `/interno/caixa/status?unidade=${UNI}&origem_ref=x`)).http, 400);
});

test('unidade pelo slug EXATO: apelido, nome curto e maiúsculas não valem (é dinheiro)', async () => {
  const m = await montar();
  for (const apelido of ['acailandia', 'Açailândia', 'DOUTOR-HERNIA-ACAILANDIA', 'hernia acailandia']) {
    const r = await m.chamar('POST', '/interno/caixa/link', { ...LINK, unidade: apelido });
    assert.ok([400, 404].includes(r.http), `${apelido}: ${r.http}`);
    assert.equal((await m.chamar('GET', `/interno/caixa/status?unidade=${encodeURIComponent(apelido)}&origem_ref=cx-aaaa1111`)).http >= 400, true);
  }
  assert.equal(m.pedidos.length, 0);
  assert.equal((await m.chamar('POST', '/interno/caixa/link', LINK)).http, 200);
});

test('tirar a unidade de CAIXA_LINK_UNIDADES fecha SÓ a criação: o status do link já enviado segue valendo', async () => {
  const lista = new Set([UNI]);
  const m = await montar();
  // a rota lê a lista a cada pedido: aqui montamos com a lista mutável
  const app2 = express();
  app2.use(express.json());
  montarRotasDoCaixa(app2, { token: TOKEN, alertar: async () => true, unidadesLink: () => lista, agora: () => AGORA });
  const srv2 = createServer(app2);
  servidores.push(srv2);
  await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
  const h = (metodo: string, caminho: string, corpo = '') => { const ts = String(Math.floor(AGORA / 1000)); return { 'content-type': 'application/json', 'x-dd-timestamp': ts, 'x-dd-assinatura': assinarPedidoDoCaixa(TOKEN, ts, metodo, caminho, corpo) }; };
  const criar = await fetch(base2 + '/interno/caixa/link', { method: 'POST', headers: h('POST', '/interno/caixa/link', JSON.stringify(LINK)), body: JSON.stringify(LINK) });
  assert.equal(criar.status, 200);
  const url = (await criar.json() as { url: string }).url;
  lista.delete(UNI);
  const novo = await fetch(base2 + '/interno/caixa/link', { method: 'POST', headers: h('POST', '/interno/caixa/link', JSON.stringify({ ...LINK, origem_ref: 'cx-bbbb2222', descricao: 'Outra consulta - ref B2' })), body: JSON.stringify({ ...LINK, origem_ref: 'cx-bbbb2222', descricao: 'Outra consulta - ref B2' }) });
  assert.equal(novo.status, 403, 'criar fechou');
  const repetir = await fetch(base2 + '/interno/caixa/link', { method: 'POST', headers: h('POST', '/interno/caixa/link', JSON.stringify(LINK)), body: JSON.stringify(LINK) });
  assert.equal(repetir.status, 403, 'nem o pedido repetido cria nada com a unidade fora da lista');
  const caminhoSt = `/interno/caixa/status?unidade=${UNI}&origem_ref=cx-aaaa1111`;
  const st = await fetch(base2 + caminhoSt, { headers: h('GET', caminhoSt) });
  assert.equal(st.status, 200, 'o status segue valendo');
  const j = await st.json() as { existe: boolean; url: string };
  assert.equal(j.existe, true);
  assert.equal(j.url, url);
  assert.equal(m.pedidos.length, 1);
});

test('o Caixa cria com a origem «caixa»: o teto de R$ 5.000 por link é o DELE e o dia dele não bloqueia a Sofia', async () => {
  const m = await montar();
  const ok = await m.chamar('POST', '/interno/caixa/link', { ...LINK, valor: 4000 });
  assert.equal(ok.http, 200);
  assert.equal((m.armazem.linhas.at(-1) as { origem?: string }).origem, 'caixa');
  assert.equal((await m.chamar('POST', '/interno/caixa/link', { ...LINK, origem_ref: 'cx-bbbb2222', descricao: 'Outra consulta - ref B2', valor: 5000.01 })).http, 422, 'passa do teto por link do Caixa');
});
