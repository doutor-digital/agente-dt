import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _zerarFalhasDeAudio,
  classificarErroDaOpenAI,
  deveIrParaEquipe,
  ehFalhaEstrutural,
  FalhaDeTranscricao,
  limparFalhasDeAudio,
  registrarFalhaDeAudio,
} from './falha-de-audio.js';

test('falta de crédito na OpenAI (o 429 de Canaã, 18/10) é estrutural e é saldo', () => {
  const c = classificarErroDaOpenAI(429, { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'You exceeded your current quota' } });
  assert.equal(c.estrutural, true);
  assert.equal(c.saldo, true);
  assert.match(c.resumo, /429 insufficient_quota/);
});

test('429 de limite por minuto é passageiro: não é saldo nem estrutural', () => {
  const c = classificarErroDaOpenAI(429, { error: { type: 'requests', code: 'rate_limit_exceeded', message: 'Rate limit reached' } });
  assert.equal(c.estrutural, false);
  assert.equal(c.saldo, false);
});

test('chave recusada (401/403) é estrutural; 500 e sem resposta são passageiros', () => {
  assert.equal(classificarErroDaOpenAI(401, null).estrutural, true);
  assert.equal(classificarErroDaOpenAI(403, {}).estrutural, true);
  assert.equal(classificarErroDaOpenAI(500, {}).estrutural, false);
  assert.equal(classificarErroDaOpenAI(undefined, undefined).estrutural, false);
});

test('ehFalhaEstrutural só reconhece a falha marcada', () => {
  assert.equal(ehFalhaEstrutural(new FalhaDeTranscricao('x', true)), true);
  assert.equal(ehFalhaEstrutural(new FalhaDeTranscricao('x', false)), false);
  assert.equal(ehFalhaEstrutural(new Error('Áudio vazio (0 bytes)')), false);
});

test('falhas seguidas: a 2ª na mesma conversa vai para a equipe; um áudio transcrito zera', () => {
  _zerarFalhasDeAudio();
  const k = 'u1:123';
  assert.equal(registrarFalhaDeAudio(k, 1000), 1);
  assert.equal(deveIrParaEquipe({ flagDaUnidade: false, estrutural: false, falhasSeguidas: 1 }), false);
  assert.equal(registrarFalhaDeAudio(k, 2000), 2);
  assert.equal(deveIrParaEquipe({ flagDaUnidade: false, estrutural: false, falhasSeguidas: 2 }), true);
  limparFalhasDeAudio(k);
  assert.equal(registrarFalhaDeAudio(k, 3000), 1);
  // depois de 12 h a sequência recomeça
  assert.equal(registrarFalhaDeAudio(k, 3000 + 13 * 3600_000), 1);
});

test('estrutural ou unidade sem áudio vão direto para a equipe, já na 1ª falha', () => {
  assert.equal(deveIrParaEquipe({ flagDaUnidade: false, estrutural: true, falhasSeguidas: 1 }), true);
  assert.equal(deveIrParaEquipe({ flagDaUnidade: true, estrutural: false, falhasSeguidas: 1 }), true);
});
