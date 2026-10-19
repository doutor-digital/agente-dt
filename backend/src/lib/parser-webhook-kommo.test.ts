import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { ROTA_WEBHOOK_KOMMO, parserDoWebhookKommo } from './parser-webhook-kommo.js';

/**
 * Revisão de 16/10/2026, item 3: o parser geral para em 1000 parâmetros e devolve 413 antes do handler. O
 * webhook de mudança de etapa traz os campos de cada cartão — 16 cartões com 30 campos já passam disso, e
 * webhook que falha seguidas vezes o Kommo desliga (o mesmo que leva as mensagens para a Sofia).
 */

/** O formato do Kommo: cada campo do cartão vem com `id`, `name` e `values[0][value]` — 3 parâmetros por campo. */
function corpoDoKommo(cartoes: number, campos: number): string {
  const p = new URLSearchParams();
  for (let i = 0; i < cartoes; i++) {
    p.append(`leads[status][${i}][id]`, String(1000 + i));
    p.append(`leads[status][${i}][status_id]`, '142');
    for (let j = 0; j < campos; j++) {
      p.append(`leads[status][${i}][custom_fields][${j}][id]`, String(500 + j));
      p.append(`leads[status][${i}][custom_fields][${j}][name]`, `Campo ${j}`);
      p.append(`leads[status][${i}][custom_fields][${j}][values][0][value]`, `v${j}`);
    }
  }
  return p.toString();
}

async function servidor() {
  const app = express();
  // A mesma ordem do server.ts.
  app.use(ROTA_WEBHOOK_KOMMO, parserDoWebhookKommo());
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  const conta = (req: express.Request, res: express.Response) => {
    const lista = (req.body as { leads?: { status?: unknown } })?.leads?.status;
    res.json({ cartoes: Array.isArray(lista) ? lista.length : null });
  };
  app.post('/api/webhooks/:unitSlug/kommo', conta);
  app.post('/api/webhooks/kommo', conta);
  app.post('/api/outra', conta);
  const http = app.listen(0);
  await new Promise<void>((ok) => http.once('listening', () => ok()));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const post = (caminho: string, corpo: string) =>
    fetch(base + caminho, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: corpo });
  return { post, fechar: () => new Promise<void>((ok) => http.close(() => ok())) };
}

test('webhook do Kommo com 16 cartões × 30 campos (> 1000 parâmetros): chega inteiro ao handler, nas duas rotas', async () => {
  const s = await servidor();
  try {
    const corpo = corpoDoKommo(16, 30);
    for (const caminho of ['/api/webhooks/doutor-hernia-acailandia/kommo', '/api/webhooks/kommo']) {
      const r = await s.post(caminho, corpo);
      assert.equal(r.status, 200, caminho);
      assert.deepEqual(await r.json(), { cartoes: 16 });
    }
  } finally {
    await s.fechar();
  }
});

test('o resto do servidor continua com o limite de sempre (1000 parâmetros → 413)', async () => {
  const s = await servidor();
  try {
    const r = await s.post('/api/outra', corpoDoKommo(16, 30));
    assert.equal(r.status, 413);
    const pequeno = await s.post('/api/outra', corpoDoKommo(2, 3));
    assert.deepEqual(await pequeno.json(), { cartoes: 2 });
  } finally {
    await s.fechar();
  }
});
