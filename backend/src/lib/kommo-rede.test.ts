import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { ehQuedaDeRede, repetirNaRede } from './kommo-rede.js';
import { buildHttp } from '../services/kommo.service.js';

const CREDS = { slug: 't', subdomain: 'teste', accessToken: 't', salesbotId: null, replyFieldId: null, bypassSalesbot: false, salesbotExecuteEnabled: false };
const semEspera = async () => {};

/** Kommo falso: derruba a conexão as `quedas` primeiras vezes com o erro dado, depois responde 200. */
function kommoQueCai(quedas: number, erro: { code: string; message: string }) {
  let chamadas = 0;
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    chamadas++;
    if (chamadas <= quedas) throw new AxiosError(erro.message, erro.code, config);
    return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
  };
  return { adapter, chamadas: () => chamadas };
}
const HANG_UP = { code: 'ECONNRESET', message: 'socket hang up' };
const TIMEOUT = { code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' };

test('regra: leitura repete em qualquer queda; gravação só se a conexão caiu antes; POST e resposta do Kommo nunca', () => {
  assert.equal(repetirNaRede({ method: 'get', ...HANG_UP }, 0), true);
  assert.equal(repetirNaRede({ method: 'get', ...TIMEOUT }, 0), true);
  assert.equal(repetirNaRede({ method: 'patch', ...HANG_UP }, 0), true);
  assert.equal(repetirNaRede({ method: 'patch', ...TIMEOUT }, 0), false, 'no timeout o PATCH pode já ter gravado');
  assert.equal(repetirNaRede({ method: 'post', ...HANG_UP }, 0), false, 'POST cria coisa — repetir duplica');
  assert.equal(repetirNaRede({ method: 'get', status: 400, message: 'Request failed with status code 400' }, 0), false);
  assert.equal(repetirNaRede({ method: 'get', status: 502, message: 'Request failed with status code 502' }, 0), false);
  assert.equal(repetirNaRede({ method: 'get', ...HANG_UP }, 2), false, 'no máximo 2 novas tentativas');
  assert.equal(ehQuedaDeRede({ message: 'aborted', code: 'ECONNRESET' }), true);
});

test('GET com "socket hang up" é repetido e responde — quem chamou nem fica sabendo', async () => {
  const k = kommoQueCai(1, HANG_UP);
  const r = await buildHttp(CREDS, { adapter: k.adapter, esperar: semEspera }).get('/leads/1');
  assert.equal(r.status, 200);
  assert.equal(k.chamadas(), 2);
});

test('PATCH com conexão cortada é repetido; com timeout NÃO (o Kommo pode já ter gravado)', async () => {
  const cortada = kommoQueCai(1, HANG_UP);
  await buildHttp(CREDS, { adapter: cortada.adapter, esperar: semEspera }).patch('/leads/1', { x: 1 });
  assert.equal(cortada.chamadas(), 2);

  const lenta = kommoQueCai(1, TIMEOUT);
  await assert.rejects(buildHttp(CREDS, { adapter: lenta.adapter, esperar: semEspera }).patch('/leads/1', { x: 1 }));
  assert.equal(lenta.chamadas(), 1);
});

test('POST nunca é repetido, e a fala da IA (semRepetirNaRede) também não', async () => {
  const post = kommoQueCai(1, HANG_UP);
  await assert.rejects(buildHttp(CREDS, { adapter: post.adapter, esperar: semEspera }).post('/leads/1/notes', {}));
  assert.equal(post.chamadas(), 1);

  const fala = kommoQueCai(1, HANG_UP);
  await assert.rejects(
    buildHttp(CREDS, { adapter: fala.adapter, esperar: semEspera }).patch('/leads/1', { x: 1 }, { semRepetirNaRede: true }),
  );
  assert.equal(fala.chamadas(), 1);
});

test('Kommo fora do ar: desiste depois de 2 novas tentativas e devolve o erro original', async () => {
  const fora = kommoQueCai(99, HANG_UP);
  await assert.rejects(buildHttp(CREDS, { adapter: fora.adapter, esperar: semEspera }).get('/leads/1'), /socket hang up/);
  assert.equal(fora.chamadas(), 3);
});
