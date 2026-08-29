import { test } from 'node:test';
import assert from 'node:assert/strict';

import { devoAvisar, limparAvisos, INTERVALO_AVISO_MS } from './paciente-insiste.js';

test('primeira mensagem com a IA pausada avisa a equipe', () => {
  limparAvisos();
  assert.equal(devoAvisar('u1:100'), true);
});

test('paciente aflito mandando 5 mensagens seguidas gera UM alerta', () => {
  limparAvisos();
  const t = Date.now();
  assert.equal(devoAvisar('u1:100', t), true);
  for (const atraso of [1_000, 5_000, 60_000, 9 * 60_000]) {
    assert.equal(devoAvisar('u1:100', t + atraso), false);
  }
});

test('passada a janela, volta a avisar — o lead continua lá', () => {
  limparAvisos();
  const t = Date.now();
  devoAvisar('u1:100', t);
  assert.equal(devoAvisar('u1:100', t + INTERVALO_AVISO_MS + 1), true);
});

test('leads diferentes não se calam entre si', () => {
  limparAvisos();
  const t = Date.now();
  assert.equal(devoAvisar('u1:100', t), true);
  assert.equal(devoAvisar('u1:200', t), true);
  assert.equal(devoAvisar('u2:100', t), true);
});
