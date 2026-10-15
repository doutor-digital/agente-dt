import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLING_AUTORIZAR,
  BLING_TOKEN,
  ErroBling,
  cabecalhoBasic,
  estadoValido,
  linkDeAutorizacao,
  pedirTokens,
  precisaRenovar,
  refreshVenceEm,
  type Fetcher,
} from './oauth.js';
import { Ritmo } from './ritmo.js';

/**
 * O OAuth do Bling tem pouca margem de erro: o código vale 1 minuto e o refresh token, se usado duas
 * vezes ou vencido, obriga um administrador a autorizar de novo. Aqui testamos o que é puro.
 */

const APP = { clientId: 'cid-123', clientSecret: 'segredo-456' };
const AGORA = new Date('2026-10-15T12:00:00Z');

function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

test('link de autorização: authorize do Bling com response_type, client_id e state', () => {
  const url = new URL(linkDeAutorizacao('cid 1', 'abc/=+'));
  assert.equal(`${url.origin}${url.pathname}`, BLING_AUTORIZAR);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'cid 1');
  assert.equal(url.searchParams.get('state'), 'abc/=+');
});

test('cabeçalho Basic = base64(client_id:client_secret)', () => {
  assert.equal(cabecalhoBasic('a', 'b'), `Basic ${Buffer.from('a:b').toString('base64')}`);
});

test('state vale 10 minutos, nem antes de gerado nem depois', () => {
  assert.equal(estadoValido(new Date(AGORA.getTime() - 9 * 60_000), AGORA), true);
  assert.equal(estadoValido(new Date(AGORA.getTime() - 11 * 60_000), AGORA), false);
  assert.equal(estadoValido(new Date(AGORA.getTime() + 60_000), AGORA), false);
  assert.equal(estadoValido(null, AGORA), false);
});

test('renova quando faltam menos de 30 min ou quando não se sabe o vencimento', () => {
  assert.equal(precisaRenovar(new Date(AGORA.getTime() + 2 * 3_600_000), AGORA), false);
  assert.equal(precisaRenovar(new Date(AGORA.getTime() + 20 * 60_000), AGORA), true);
  assert.equal(precisaRenovar(new Date(AGORA.getTime() - 60_000), AGORA), true);
  assert.equal(precisaRenovar(null, AGORA), true);
});

test('refresh token vence 30 dias depois de emitido', () => {
  assert.equal(refreshVenceEm(AGORA).toISOString(), '2026-11-14T12:00:00.000Z');
});

test('pedirTokens: POST no /oauth/token com Basic e formulário, sem o segredo no corpo', async () => {
  let visto: { url: string; init?: RequestInit } | null = null;
  const fetcher: Fetcher = async (url, init) => {
    visto = { url, init };
    return respostaJson(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 21600, token_type: 'Bearer', scope: '1 2 3' });
  };
  const t = await pedirTokens(APP, { grant_type: 'authorization_code', code: 'XYZ' }, fetcher, AGORA);
  assert.ok(visto);
  const v = visto as { url: string; init?: RequestInit };
  assert.equal(v.url, BLING_TOKEN);
  assert.equal(v.init?.method, 'POST');
  const h = v.init?.headers as Record<string, string>;
  assert.equal(h.Authorization, cabecalhoBasic(APP.clientId, APP.clientSecret));
  assert.equal(h['Content-Type'], 'application/x-www-form-urlencoded');
  const corpo = new URLSearchParams(String(v.init?.body));
  assert.equal(corpo.get('grant_type'), 'authorization_code');
  assert.equal(corpo.get('code'), 'XYZ');
  assert.equal(String(v.init?.body).includes(APP.clientSecret), false);
  assert.deepEqual(t, { accessToken: 'AT', refreshToken: 'RT', expiraEm: new Date(AGORA.getTime() + 21_600_000), escopos: '1 2 3' });
});

test('pedirTokens: sem expires_in assume 6 h', async () => {
  const t = await pedirTokens(APP, { grant_type: 'refresh_token', refresh_token: 'R' }, async () => respostaJson(200, { access_token: 'A', refresh_token: 'B' }), AGORA);
  assert.equal(t.expiraEm.getTime() - AGORA.getTime(), 21_600_000);
});

test('pedirTokens: invalid_grant vira "precisa reautorizar"', async () => {
  await assert.rejects(
    pedirTokens(APP, { grant_type: 'refresh_token', refresh_token: 'velho' }, async () => respostaJson(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' }), AGORA),
    (e: unknown) => e instanceof ErroBling && e.precisaReautorizar && e.status === 400 && /invalid_grant/.test(e.message),
  );
});

test('pedirTokens: erro no formato v3 ({ error: { type, message } }) não é reautorização se não for grant', async () => {
  await assert.rejects(
    pedirTokens(APP, { grant_type: 'authorization_code', code: 'c' }, async () => respostaJson(401, { error: { type: 'unauthorized', message: 'cliente inválido' } }), AGORA),
    (e: unknown) => e instanceof ErroBling && !e.precisaReautorizar && e.status === 401 && /cliente inválido/.test(e.message),
  );
});

test('pedirTokens: 200 sem access_token é erro (não grava par pela metade)', async () => {
  await assert.rejects(pedirTokens(APP, { grant_type: 'authorization_code', code: 'c' }, async () => respostaJson(200, { refresh_token: 'só isso' }), AGORA), ErroBling);
});

test('pedirTokens: rede fora vira ErroBling sem status', async () => {
  await assert.rejects(
    pedirTokens(APP, { grant_type: 'authorization_code', code: 'c' }, async () => { throw new Error('ECONNRESET'); }, AGORA),
    (e: unknown) => e instanceof ErroBling && e.status === null,
  );
});

test('Ritmo: no máximo uma chamada por intervalo, em ordem, sem esperar à toa', async () => {
  let t = 1000;
  const esperas: number[] = [];
  const r = new Ritmo(360, () => t, async (ms) => { esperas.push(ms); });
  await r.vez(); // começa já
  await r.vez(); // espera 360
  await r.vez(); // espera 720 (a fila anda mesmo sem o relógio andar)
  assert.deepEqual(esperas, [360, 720]);
  t = 5000; // muito tempo depois: não espera
  await r.vez();
  assert.deepEqual(esperas, [360, 720]);
});
