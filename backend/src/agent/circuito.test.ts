import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  circuitoAberto,
  registrarFalha,
  registrarSucesso,
  ehFalhaDeInfra,
  estadoDoCircuito,
  resetarCircuitos,
} from './circuito.js';

/**
 * Provedor fora do ar custava 55 segundos por mensagem (35s no principal + 20s
 * no plano B), em toda mensagem, indefinidamente. O paciente esperava quase um
 * minuto para receber "tive uma instabilidade" — e a mensagem seguinte pagava
 * a conta de novo.
 */

const AGORA = 1_000_000;

beforeEach(() => resetarCircuitos());

test('uma falha isolada não corta — ruído acontece', () => {
  registrarFalha('anthropic', AGORA);
  assert.equal(circuitoAberto('anthropic', AGORA), false);
});

test('três falhas seguidas cortam o provedor', () => {
  registrarFalha('anthropic', AGORA);
  registrarFalha('anthropic', AGORA);
  const abriu = registrarFalha('anthropic', AGORA);

  assert.equal(abriu, true, 'a terceira é a que abre');
  assert.equal(circuitoAberto('anthropic', AGORA), true);
});

test('sucesso no meio zera a contagem', () => {
  registrarFalha('anthropic', AGORA);
  registrarFalha('anthropic', AGORA);
  registrarSucesso('anthropic');
  registrarFalha('anthropic', AGORA);

  assert.equal(circuitoAberto('anthropic', AGORA), false, 'falha esparsa não pode acumular pra sempre');
});

test('cortar um provedor não afeta os outros', () => {
  for (let i = 0; i < 3; i++) registrarFalha('anthropic', AGORA);

  assert.equal(circuitoAberto('anthropic', AGORA), true);
  assert.equal(circuitoAberto('openai', AGORA), false);
  assert.equal(circuitoAberto('google', AGORA), false);
});

test('depois do descanso, deixa passar uma tentativa', () => {
  for (let i = 0; i < 3; i++) registrarFalha('anthropic', AGORA);
  assert.equal(circuitoAberto('anthropic', AGORA + 30_000), true, 'ainda descansando');

  assert.equal(circuitoAberto('anthropic', AGORA + 61_000), false, 'passou o descanso: sonda');
});

test('se a sonda falhar, corta de novo', () => {
  for (let i = 0; i < 3; i++) registrarFalha('anthropic', AGORA);
  const depois = AGORA + 61_000;
  circuitoAberto('anthropic', depois); // consome a sonda

  registrarFalha('anthropic', depois);
  assert.equal(circuitoAberto('anthropic', depois), true, 'provedor ainda fora → volta a cortar');
});

test('se a sonda der certo, o provedor volta sozinho', () => {
  for (let i = 0; i < 3; i++) registrarFalha('anthropic', AGORA);
  const depois = AGORA + 61_000;
  circuitoAberto('anthropic', depois);

  registrarSucesso('anthropic');
  assert.equal(circuitoAberto('anthropic', depois), false, 'ninguém precisa mexer pra ele voltar');
});

// ── o que conta como "provedor fora" ────────────────────────────────────────

test('falha de infraestrutura corta', () => {
  const timeout = new Error('IA não respondeu em 35000ms');
  timeout.name = 'LlmTimeoutError';

  assert.equal(ehFalhaDeInfra(timeout), true);
  assert.equal(ehFalhaDeInfra(new Error('connect ETIMEDOUT 1.2.3.4:443')), true);
  assert.equal(ehFalhaDeInfra(new Error('socket hang up')), true);
  assert.equal(ehFalhaDeInfra(new Error('Overloaded')), true);
  assert.equal(ehFalhaDeInfra(Object.assign(new Error('x'), { status: 503 })), true);
});

test('recusa do modelo NÃO corta — trocar de provedor não resolveria', () => {
  assert.equal(ehFalhaDeInfra(new Error('invalid_request_error: prompt too long')), false);
  assert.equal(ehFalhaDeInfra(Object.assign(new Error('bad request'), { status: 400 })), false);
  assert.equal(ehFalhaDeInfra(new Error('credit balance is too low')), false);
});

test('o retrato mostra quem está cortado e quanto falta', () => {
  for (let i = 0; i < 3; i++) registrarFalha('openai', AGORA);
  const foto = estadoDoCircuito(AGORA + 10_000).find((x) => x.provedor === 'openai');

  assert.equal(foto?.aberto, true);
  assert.equal(foto?.falhasSeguidas, 3);
  assert.ok((foto?.voltaEmMs ?? 0) > 0);
});
