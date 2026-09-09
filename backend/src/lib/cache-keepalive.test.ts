import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deveAquecer, horaLocal, OCIOSO_MIN, OCIOSO_MAX, HORA_INICIO, HORA_FIM } from './cache-keepalive-worker.js';

test('keepalive: só aquece na faixa em que o cache de 1 h está prestes a vencer', () => {
  assert.equal(deveAquecer(OCIOSO_MIN - 1, 12), false, 'antes da faixa a conversa ainda pode voltar sozinha');
  assert.equal(deveAquecer(OCIOSO_MIN, 12), true);
  assert.equal(deveAquecer(OCIOSO_MAX, 12), true);
  assert.equal(deveAquecer(OCIOSO_MAX + 1, 12), false, 'depois de 1 h o cache já venceu: regravar aqui seria gastar à toa');
  assert.equal(deveAquecer(0, 12), false);
});

test('keepalive: fora da janela do dia deixa o cache vencer', () => {
  assert.equal(deveAquecer(50, HORA_INICIO - 1), false);
  assert.equal(deveAquecer(50, HORA_INICIO), true);
  assert.equal(deveAquecer(50, HORA_FIM - 1), true);
  assert.equal(deveAquecer(50, HORA_FIM), false);
});

test('keepalive: hora local respeita o fuso da unidade', () => {
  const meioDiaUtc = Date.UTC(2026, 8, 9, 12, 0, 0);
  assert.equal(horaLocal(meioDiaUtc, 'America/Sao_Paulo'), 9);
  assert.equal(horaLocal(meioDiaUtc, 'America/Manaus'), 8);
  assert.equal(horaLocal(meioDiaUtc, 'America/Boa_Vista'), 8);
  assert.equal(horaLocal(Date.UTC(2026, 8, 9, 2, 30, 0), 'America/Sao_Paulo'), 23);
});
