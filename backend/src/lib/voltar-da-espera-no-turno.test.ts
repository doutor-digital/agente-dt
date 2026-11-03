import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voltarDaEsperaNoTurno } from './voltar-da-espera-no-turno.js';

test('turno ao vivo: volta da espera (como sempre)', async () => {
  let n = 0;
  assert.equal(await voltarDaEsperaNoTurno(undefined, async () => void n++), true);
  assert.equal(await voltarDaEsperaNoTurno(false, async () => void n++), true);
  assert.equal(n, 2);
});

test('turno RETOMADO depois de um deploy: não mexe na etapa', async () => {
  let n = 0;
  assert.equal(await voltarDaEsperaNoTurno(true, async () => void n++), false);
  assert.equal(n, 0);
});
