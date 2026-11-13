/**
 * Tradutor Chatwoot → Kapso: só caminho da Graph (vNN.N/...) ou /_kapso/meta/...; destino fixo api.kapso.ai; Bearer vira
 * X-API-Key; URL do Kapso na resposta volta reescrita para passar pelo tradutor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveDoBearer, destinoNoKapso, kapsoProxyHandler, querySemChave, reescreverUrls } from './kapso-proxy.controller.js';

const CHAVE = '1dfff777aaaabbbbccccddddeeeeffff00001111';

test('destino: Graph vira api.kapso.ai/meta/whatsapp; _kapso só meta/; nada de outro host ou ..', () => {
  assert.equal(destinoNoKapso('v13.0/1212928641906230/messages'), 'https://api.kapso.ai/meta/whatsapp/v13.0/1212928641906230/messages');
  assert.equal(destinoNoKapso('v14.0/2146287749563217/message_templates'), 'https://api.kapso.ai/meta/whatsapp/v14.0/2146287749563217/message_templates');
  assert.equal(destinoNoKapso('_kapso/meta/whatsapp/media/abc'), 'https://api.kapso.ai/meta/whatsapp/media/abc');
  assert.equal(destinoNoKapso('_kapso/platform/v1/whatsapp/phone_numbers'), null);
  assert.equal(destinoNoKapso('v13.0/../../platform'), null);
  assert.equal(destinoNoKapso('evil.com/x'), null);
  assert.equal(destinoNoKapso('v13.0/x?y'), null);
});

test('Bearer: só o formato esperado', () => {
  assert.equal(chaveDoBearer(`Bearer ${CHAVE}`), CHAVE);
  assert.equal(chaveDoBearer('Bearer curta'), null);
  assert.equal(chaveDoBearer(undefined), null);
  assert.equal(chaveDoBearer(`Basic ${CHAVE}`), null);
});

test('reescreve URL do Kapso na resposta, mantém as outras', () => {
  const r = reescreverUrls({ url: 'https://api.kapso.ai/meta/whatsapp/media/9?x=1', outra: 'https://lookaside.fbsbx.com/a', n: [1, 'https://api.kapso.ai/meta/b'] }, 'https://ag/api/public/kapso-meta');
  assert.deepEqual(r, { url: 'https://ag/api/public/kapso-meta/_kapso/meta/whatsapp/media/9?x=1', outra: 'https://lookaside.fbsbx.com/a', n: [1, 'https://ag/api/public/kapso-meta/_kapso/meta/b'] });
});

function resFalso() {
  const r: any = { statusCode: 0, corpo: undefined as unknown, cab: {} as Record<string, string>, headersSent: false };
  r.status = (s: number) => ((r.statusCode = s), r);
  r.json = (b: unknown) => ((r.corpo = b), (r.headersSent = true), r);
  r.send = (b: unknown) => ((r.corpo = b), (r.headersSent = true), r);
  r.type = (t: string) => ((r.cab['content-type'] = t), r);
  r.set = (k: string, v: string) => ((r.cab[k] = v), r);
  return r;
}
function reqFalso(o: { metodo?: string; caminho: string; auth?: string; corpo?: unknown; url?: string }) {
  return {
    method: o.metodo ?? 'POST',
    params: { 0: o.caminho },
    body: o.corpo,
    originalUrl: o.url ?? `/api/public/kapso-meta/${o.caminho}`,
    get: (h: string) => (h.toLowerCase() === 'authorization' ? o.auth : undefined),
  } as any;
}

test('repassa com X-API-Key, corpo JSON e query; devolve status e JSON', async () => {
  const chamadas: Array<{ url: string; init: any }> = [];
  const f = (async (url: string, init: any) => {
    chamadas.push({ url, init });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const res = resFalso();
  await kapsoProxyHandler(reqFalso({ caminho: 'v13.0/123/messages', auth: `Bearer ${CHAVE}`, corpo: { to: '5594', type: 'text' }, url: '/api/public/kapso-meta/v13.0/123/messages?a=1' }), res, { fetch: f });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.corpo, { messages: [{ id: 'wamid.1' }] });
  assert.equal(chamadas[0]!.url, 'https://api.kapso.ai/meta/whatsapp/v13.0/123/messages?a=1');
  assert.equal(chamadas[0]!.init.headers['X-API-Key'], CHAVE);
  assert.equal(chamadas[0]!.init.headers.Authorization, undefined);
  assert.equal(chamadas[0]!.init.body, JSON.stringify({ to: '5594', type: 'text' }));
});

test('sem Bearer = 401; caminho ruim = 400; Kapso fora = 502 (sem lançar)', async () => {
  const nunca = (async () => {
    throw new Error('não devia chamar');
  }) as unknown as typeof fetch;
  const r1 = resFalso();
  await kapsoProxyHandler(reqFalso({ caminho: 'v13.0/1/messages' }), r1, { fetch: nunca });
  assert.equal(r1.statusCode, 401);
  const r2 = resFalso();
  await kapsoProxyHandler(reqFalso({ caminho: 'x/1', auth: `Bearer ${CHAVE}` }), r2, { fetch: nunca });
  assert.equal(r2.statusCode, 400);
  const r3 = resFalso();
  await kapsoProxyHandler(reqFalso({ metodo: 'GET', caminho: 'v13.0/1', auth: `Bearer ${CHAVE}` }), r3, { fetch: nunca });
  assert.equal(r3.statusCode, 502);
});

test('mídia: repassa bytes e tipo', async () => {
  const f = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/ogg', 'content-length': '3' } })) as unknown as typeof fetch;
  const res = resFalso();
  await kapsoProxyHandler(reqFalso({ metodo: 'GET', caminho: '_kapso/meta/whatsapp/media/9', auth: `Bearer ${CHAVE}` }), res, { fetch: f });
  assert.equal(res.statusCode, 200);
  assert.equal(res.cab['content-type'], 'audio/ogg');
  assert.deepEqual([...(res.corpo as Buffer)], [1, 2, 3]);
});

test('chave na URL (?access_token=, validação do Chatwoot): vale e NÃO segue para o Kapso', async () => {
  assert.deepEqual(querySemChave(`/x?access_token=${CHAVE}&fields=id&limit=100`), { query: '?fields=id&limit=100', chave: CHAVE });
  assert.deepEqual(querySemChave('/x'), { query: '', chave: null });
  assert.deepEqual(querySemChave('/x?access_token=curta'), { query: '', chave: null });
  const chamadas: Array<{ url: string; init: any }> = [];
  const f = (async (url: string, init: any) => {
    chamadas.push({ url, init });
    return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const res = resFalso();
  await kapsoProxyHandler(reqFalso({ metodo: 'GET', caminho: 'v14.0/2146/message_templates', url: `/api/public/kapso-meta/v14.0/2146/message_templates?access_token=${CHAVE}` }), res, { fetch: f });
  assert.equal(res.statusCode, 200);
  assert.equal(chamadas[0]!.url, 'https://api.kapso.ai/meta/whatsapp/v14.0/2146/message_templates');
  assert.equal(chamadas[0]!.init.headers['X-API-Key'], CHAVE);
});
