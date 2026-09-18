import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segredoConfere } from './whatsapp-meta.controller.js';

const BOM = 'segredo-de-16-ou-mais-caracteres';

test('o segredo certo passa', () => {
  assert.equal(segredoConfere(BOM, BOM), true);
  assert.equal(segredoConfere(` ${BOM} `, BOM), true);
});

test('segredo errado, curto ou ausente não passa', () => {
  assert.equal(segredoConfere('outra-coisa-qualquer-aqui', BOM), false);
  assert.equal(segredoConfere(undefined, BOM), false);
  assert.equal(segredoConfere('', BOM), false);
  assert.equal(segredoConfere(BOM.slice(0, -1), BOM), false);
});

test('sem variável de ambiente a rota fica fechada, não aberta', () => {
  // o erro clássico: segredo em branco casa com header em branco e libera geral
  assert.equal(segredoConfere('', undefined), false);
  assert.equal(segredoConfere('', ''), false);
  assert.equal(segredoConfere(undefined, undefined), false);
});

test('segredo fraco demais é tratado como inexistente', () => {
  assert.equal(segredoConfere('1234', '1234'), false);
});

test('header que não é texto não passa', () => {
  assert.equal(segredoConfere(['a', 'b'], BOM), false);
  assert.equal(segredoConfere(42, BOM), false);
});
