import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ROTA_WEBHOOK_PLUGGY, ligarWebhookPluggy } from './pluggy-webhook.controller.js';
import type { DependenciasDoWebhook } from '../lib/integracoes/pluggy-webhook.js';

const SEGREDO = `whsec_${'ab12'.repeat(16)}`;
const ITEM = 'a5c763cb-0952-457b-9936-630f79c5b016';

const assinar = (corpo: string, segredo = SEGREDO, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', segredo).update(`${t}.${corpo}`).digest('hex')}`;

async function servidor(env: NodeJS.ProcessEnv) {
  const invalidados: string[] = [];
  const deps: DependenciasDoWebhook = {
    ambiente: () => env,
    agora: Date.now,
    invalidarItem: (id) => void invalidados.push(id),
    avisar: async () => true,
    log: { info: () => undefined, warn: () => undefined },
    itensConhecidos: () => new Map([[ITEM, {}]]),
  };
  const app = express();
  ligarWebhookPluggy(app, deps);
  // o parser JSON geral vem DEPOIS, como no server.ts: a rota da Pluggy já leu o corpo cru e ele não pode ser re-lido
  app.use(express.json());
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, invalidados, fechar: () => new Promise<void>((r) => srv.close(() => r())) };
}

const enviar = (base: string, corpo: string, cabecalhos: Record<string, string>) => fetch(`${base}${ROTA_WEBHOOK_PLUGGY}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cabecalhos }, body: corpo });

test('HTTP: assinatura válida sobre o corpo cru = 200 e o item é invalidado; os bytes exatos são os que contam (espaços e ordem)', async () => {
  const s = await servidor({ PLUGGY_WEBHOOK_SECRET: SEGREDO });
  try {
    // JSON com espaços e chaves fora de ordem: se a rota re-serializasse, a assinatura não bateria
    const corpo = `{ "itemId": "${ITEM}",   "event":"item/updated" , "eventId":"h1"}`;
    const r = await enviar(s.base, corpo, { 'X-Pluggy-Signature': assinar(corpo) });
    assert.equal(r.status, 200);
    await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(s.invalidados, [ITEM]);
  } finally {
    await s.fechar();
  }
});

test('HTTP: sem cabeçalho, assinatura errada e timestamp velho = 401', async () => {
  const s = await servidor({ PLUGGY_WEBHOOK_SECRET: SEGREDO });
  try {
    const corpo = JSON.stringify({ event: 'item/updated', eventId: 'h2', itemId: ITEM });
    assert.equal((await enviar(s.base, corpo, {})).status, 401);
    assert.equal((await enviar(s.base, corpo, { 'X-Pluggy-Signature': assinar(corpo, `whsec_${'ff'.repeat(32)}`) })).status, 401);
    assert.equal((await enviar(s.base, corpo, { 'X-Pluggy-Signature': assinar(corpo, SEGREDO, Math.floor(Date.now() / 1000) - 3600) })).status, 401);
    await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(s.invalidados, []);
  } finally {
    await s.fechar();
  }
});

test('HTTP: sem PLUGGY_WEBHOOK_SECRET a rota responde 404, mesmo com assinatura', async () => {
  const s = await servidor({});
  try {
    const corpo = JSON.stringify({ event: 'item/updated', eventId: 'h3', itemId: ITEM });
    assert.equal((await enviar(s.base, corpo, { 'X-Pluggy-Signature': assinar(corpo) })).status, 404);
  } finally {
    await s.fechar();
  }
});

test('HTTP: content-type que não é JSON também chega cru (a assinatura é sobre bytes)', async () => {
  const s = await servidor({ PLUGGY_WEBHOOK_SECRET: SEGREDO });
  try {
    const corpo = JSON.stringify({ event: 'item/updated', eventId: 'h4', itemId: ITEM });
    const r = await fetch(`${s.base}${ROTA_WEBHOOK_PLUGGY}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Pluggy-Signature': assinar(corpo) }, body: corpo });
    assert.equal(r.status, 200);
  } finally {
    await s.fechar();
  }
});

test('o servidor monta a rota ANTES do parser JSON geral e do apiRouter (fonte)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const i = src.indexOf('ligarWebhookPluggy(app)');
  assert.ok(i > 0);
  assert.ok(i < src.indexOf('express.json({'), 'a assinatura é sobre o corpo cru: tem de vir antes do express.json geral');
  assert.ok(i < src.indexOf("app.use('/api', apiRouter)"));
});
