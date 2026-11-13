/**
 * Autorização das rotas da tela Agente e do 👍/👎 do balão (pedido do sênior, 13/11/2026): sem login = 401; unidade que a pessoa
 * não atende = 403 (antes de qualquer leitura no banco); mensagem que não é resposta da Sofia NESTA conversa = 404; conversa de
 * caixa sem IA = 422. E a nota privada da 👎 sai ANTES de gravar (se ela falhar, nada fica gravado e a nova tentativa manda de novo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

process.env.CHATWOOT_API_TOKEN = 'token-da-conta';
process.env.CHATWOOT_CONTA_ID = '1';
process.env.CHATWOOT_URL = 'https://chatwoot.exemplo.test';

// o Chatwoot falso: um login que vale ('bom'), as caixas que ela vê e a caixa de cada conversa
const cw = { caixas: [2] as number[], caixaDaConversa: { 31: 2, 40: 9 } as Record<number, number>, falharNota: false, ordem: [] as string[] };
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (u.endsWith('/api/v1/profile')) {
    return headers['access-token'] === 'bom' ? new Response(JSON.stringify({ id: 7, name: 'Ana', accounts: [{ id: 1 }] }), { status: 200 }) : new Response('{}', { status: 401 });
  }
  if (/\/inboxes(\?|$)/.test(u)) return new Response(JSON.stringify({ payload: cw.caixas.map((id) => ({ id })) }), { status: 200 });
  const conv = u.match(/\/conversations\/(\d+)(\/messages)?(\?|$)/);
  if (conv && init?.method === 'POST' && conv[2]) {
    cw.ordem.push('nota');
    return cw.falharNota ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }
  if (conv && !conv[2]) {
    const caixa = cw.caixaDaConversa[Number(conv[1])];
    return caixa ? new Response(JSON.stringify({ id: Number(conv[1]), inbox_id: caixa, labels: [], custom_attributes: {}, meta: {} }), { status: 200 }) : new Response('{}', { status: 404 });
  }
  return new Response(JSON.stringify({ payload: [] }), { status: 200 });
}) as typeof fetch;

const { agenteNovoPedidoHandler, agentePainelHandler, agentePedidosHandler, agenteRevisarHandler } = await import('./agente-chatwoot.controller.js');
const { assistenteAvaliarHandler, assistenteRespostasHandler } = await import('./assistente.controller.js');
const { bancoDeAvaliacoes } = await import('../lib/sofia-avaliacoes.js');

const PARAU = 'doutor-hernia-parauapebas';
const LOGIN = { 'x-cw-token': 'bom', 'x-cw-client': 'c', 'x-cw-uid': 'ana@dd.com' };

function resp() {
  const r = { codigo: 200, corpo: undefined as any, status(n: number) { r.codigo = n; return r; }, json(c: unknown) { r.corpo = c; return r; }, type() { return r; }, set() { return r; }, send(c: unknown) { r.corpo = c; return r; } };
  return r;
}
const req = (o: { body?: unknown; query?: Record<string, string>; params?: Record<string, string>; headers?: Record<string, string> }) =>
  ({ body: o.body ?? {}, query: o.query ?? {}, params: o.params ?? {}, ip: '1.1.1.1', get: (n: string) => (o.headers ?? {})[n.toLowerCase()] }) as unknown as Request;
const asRes = (r: ReturnType<typeof resp>) => r as unknown as Response;

test('sem login do Chatwoot: 401 em todas as rotas do Agente', async () => {
  for (const [h, pedido] of [
    [agentePainelHandler, req({ query: { slug: PARAU } })],
    [agentePedidosHandler, req({ query: { slug: PARAU } })],
    [agenteRevisarHandler, req({ body: { slug: PARAU, como: 'ok' }, params: { id: 'x' } })],
    [agenteNovoPedidoHandler, req({ body: { slug: PARAU, tipo: 'erro', texto: 'A Sofia não respondeu ontem.' } })],
  ] as const) {
    const r = resp();
    await h(pedido, asRes(r));
    assert.equal(r.codigo, 401, String(h.name));
  }
});

test('unidade que ela não atende: 403 antes de ler o banco (painel, pedidos, revisar, novo pedido)', async () => {
  cw.caixas = [9]; // a caixa 9 não é de unidade nenhuma do mapa
  try {
    for (const [h, pedido] of [
      [agentePainelHandler, req({ query: { slug: PARAU }, headers: LOGIN })],
      [agentePedidosHandler, req({ query: { slug: PARAU }, headers: LOGIN })],
      [agenteRevisarHandler, req({ body: { slug: PARAU, como: 'ok' }, params: { id: 'x' }, headers: LOGIN })],
      [agenteNovoPedidoHandler, req({ body: { slug: PARAU, tipo: 'erro', texto: 'A Sofia não respondeu ontem.' }, headers: LOGIN })],
    ] as const) {
      const r = resp();
      await h(pedido, asRes(r));
      assert.equal(r.codigo, 403, String(h.name));
    }
  } finally {
    cw.caixas = [2];
  }
});

test('revisar e pedir para OUTRA unidade (ela atende Parauapebas): 403', async () => {
  const r1 = resp();
  await agenteRevisarHandler(req({ body: { slug: 'doutor-hernia-timbo', como: 'ok' }, params: { id: 'x' }, headers: LOGIN }), asRes(r1));
  assert.equal(r1.codigo, 403);
  const r2 = resp();
  await agenteNovoPedidoHandler(req({ body: { slug: 'doutor-hernia-timbo', tipo: 'valor', texto: 'Mudar o valor da consulta.' }, headers: LOGIN }), asRes(r2));
  assert.equal(r2.codigo, 403);
});

test('avaliar: mensagem que não é resposta da Sofia nesta conversa = 404; conversa de caixa sem IA = 422', async () => {
  const orig = { ...bancoDeAvaliacoes };
  let gravou = 0;
  bancoDeAvaliacoes.respostaDaSofia = async (mensagem, conversa) => (mensagem === 500 && conversa === 31 ? { unitSlug: PARAU } : null);
  bancoDeAvaliacoes.gravarAvaliacao = async () => {
    gravou++;
  };
  try {
    const r = resp();
    await assistenteAvaliarHandler(req({ body: { conversa: 31, mensagem: 777, nota: 'boa' }, headers: LOGIN }), asRes(r));
    assert.equal(r.codigo, 404);
    const r2 = resp();
    await assistenteAvaliarHandler(req({ body: { conversa: 40, mensagem: 500, nota: 'boa' }, headers: LOGIN }), asRes(r2));
    assert.equal(r2.codigo, 422, 'conversa 40 é da caixa 9 (sem IA)');
    const r3 = resp();
    await assistenteRespostasHandler(req({ query: { conversa: '40' }, headers: LOGIN }), asRes(r3));
    assert.equal(r3.codigo, 422);
    assert.equal(gravou, 0);
  } finally {
    Object.assign(bancoDeAvaliacoes, orig);
  }
});

test('avaliar 👎: a nota privada sai antes de gravar; se a nota falha, nada é gravado (e a nova tentativa manda a nota)', async () => {
  const orig = { ...bancoDeAvaliacoes };
  const gravadas: unknown[] = [];
  bancoDeAvaliacoes.respostaDaSofia = async () => ({ unitSlug: PARAU });
  bancoDeAvaliacoes.minhaAvaliacao = async () => null;
  bancoDeAvaliacoes.gravarAvaliacao = async (a) => {
    cw.ordem.push('gravar');
    gravadas.push(a);
  };
  try {
    cw.ordem = [];
    cw.falharNota = true;
    const r = resp();
    await assistenteAvaliarHandler(req({ body: { conversa: 31, mensagem: 500, nota: 'ruim', texto: 'devia dizer o valor' }, headers: LOGIN }), asRes(r));
    assert.equal(r.codigo, 502);
    assert.deepEqual(cw.ordem, ['nota'], 'a nota falhou: nada gravado');
    cw.falharNota = false;
    cw.ordem = [];
    const r2 = resp();
    await assistenteAvaliarHandler(req({ body: { conversa: 31, mensagem: 500, nota: 'ruim', texto: 'devia dizer o valor' }, headers: LOGIN }), asRes(r2));
    assert.equal(r2.codigo, 200);
    assert.deepEqual(cw.ordem, ['nota', 'gravar']);
    assert.equal((gravadas[0] as { slug: string }).slug, PARAU);
  } finally {
    Object.assign(bancoDeAvaliacoes, orig);
    cw.falharNota = false;
  }
});

test('avaliar pelo painel (sem mensagem): usa a última resposta gravada; 👍 sem resposta gravada não cria linha', async () => {
  const orig = { ...bancoDeAvaliacoes };
  const gravadas: Array<{ mensagem: number | null }> = [];
  bancoDeAvaliacoes.minhaAvaliacao = async () => null;
  bancoDeAvaliacoes.gravarAvaliacao = async (a) => {
    gravadas.push(a);
  };
  try {
    bancoDeAvaliacoes.ultimaRespostaDaSofia = async () => 900;
    const r = resp();
    await assistenteAvaliarHandler(req({ body: { conversa: 31, nota: 'boa' }, headers: LOGIN }), asRes(r));
    assert.equal(r.codigo, 200);
    assert.equal(gravadas.at(-1)?.mensagem, 900);
    bancoDeAvaliacoes.ultimaRespostaDaSofia = async () => null;
    const r2 = resp();
    await assistenteAvaliarHandler(req({ body: { conversa: 31, nota: 'boa' }, headers: LOGIN }), asRes(r2));
    assert.equal(r2.codigo, 200);
    assert.equal(gravadas.length, 1, '👍 sem resposta gravada só vai para o log');
  } finally {
    Object.assign(bancoDeAvaliacoes, orig);
  }
});
