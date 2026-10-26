import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { _limparPausasProprias, esquecerPausaPropria, registrarPausaPropria, segurarRespostaAtropelada } from './pausa-propria.js';

const conta = { kommoSubdomain: 'marabadoutorhernia' };

beforeEach(() => _limparPausasProprias());

test('segura a atropelada quando o próximo turno vai responder', () => {
  assert.equal(segurarRespostaAtropelada(conta, 29029780, 1_000, true), true);
});

test('não segura sem mensagem nova', () => {
  assert.equal(segurarRespostaAtropelada(conta, 29029780, 1_000, false), false);
});

test('Marabá 29029780: a Sofia pausou no turno (sinal de alerta) → a resposta sai, o próximo turno é pulado', () => {
  registrarPausaPropria(conta, 29029780, 2_000);
  assert.equal(segurarRespostaAtropelada(conta, 29029780, 1_000, true), false);
});

test('pausa própria de um turno ANTERIOR não solta a atropelada deste', () => {
  registrarPausaPropria(conta, 29029780, 500);
  assert.equal(segurarRespostaAtropelada(conta, 29029780, 1_000, true), true);
});

test('pausa própria em outra conta com o mesmo número de cartão não conta', () => {
  registrarPausaPropria({ kommoSubdomain: 'outraconta' }, 29029780, 2_000);
  assert.equal(segurarRespostaAtropelada(conta, 29029780, 1_000, true), true);
});

test('a pausa falhou no Kommo: esquecer a marca volta a segurar a atropelada', () => {
  registrarPausaPropria(conta, 29029780, 2_000);
  esquecerPausaPropria(conta, 29029780);
  assert.equal(segurarRespostaAtropelada(conta, 29029780, 1_000, true), true);
});

test('esquecer a marca de uma conta não apaga a de outra', () => {
  registrarPausaPropria(conta, 29029780, 2_000);
  esquecerPausaPropria({ kommoSubdomain: 'outraconta' }, 29029780);
  assert.equal(segurarRespostaAtropelada(conta, 29029780, 1_000, true), false);
});
