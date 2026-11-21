/**
 * O worker da demora zera a memória do processo a cada start/stop: o supervisor do lease para os workers quando outra cópia vira líder e liga de
 * novo quando esta volta. Sem zerar, esta cópia reusaria o marcador «ligado desde» VELHO (e o «já apaguei o marcador») e, se a automação tivesse
 * passado por seco no meio, a fila do intervalo sairia de uma vez.
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-tamanho-suficiente-123456';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const W = await import('./crm-demora-worker.js');

test('start e stop zeram a memória do processo (marcador «ligado desde», «já apaguei», esperas)', () => {
  delete process.env.CHATWOOT_API_TOKEN; // sem conta no ambiente: o start não sobe timer nenhum, mas zera a memória antes
  const velha = W.memoriaDoWorker();
  velha.ligadoDesde.set(3, new Date('2026-11-01T12:00:00Z'));
  velha.semMarcador.add(3);
  W.stopCrmDemoraWorker();
  const depoisDoStop = W.memoriaDoWorker();
  assert.notEqual(depoisDoStop, velha);
  assert.equal(depoisDoStop.ligadoDesde.size, 0);
  depoisDoStop.ligadoDesde.set(3, new Date('2026-11-02T12:00:00Z'));
  depoisDoStop.semMarcador.add(3);
  W.startCrmDemoraWorker();
  const depoisDoStart = W.memoriaDoWorker();
  assert.equal(depoisDoStart.ligadoDesde.size, 0);
  assert.equal(depoisDoStart.semMarcador.size, 0);
  W.stopCrmDemoraWorker();
});
