import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  marcarNaoEntregue,
  consumirNaoEntregue,
  limparNaoEntregues,
  renderEntregaFalha,
  VALIDADE_MS,
} from './entrega-falha.js';

test('o que não chegou volta no turno seguinte', () => {
  limparNaoEntregues();
  marcarNaoEntregue('u1', 100, 'A consulta é R$ 350.');
  assert.equal(consumirNaoEntregue('u1', 100), 'A consulta é R$ 350.');
});

test('o aviso some depois de usado — senão ela pede desculpa em loop', () => {
  limparNaoEntregues();
  marcarNaoEntregue('u1', 100, 'texto');
  consumirNaoEntregue('u1', 100);
  assert.equal(consumirNaoEntregue('u1', 100), null);
});

test('depois de 30 min a conversa já seguiu; repetir não faz sentido', () => {
  limparNaoEntregues();
  const t = Date.now();
  marcarNaoEntregue('u1', 100, 'texto', t);
  assert.equal(consumirNaoEntregue('u1', 100, t + VALIDADE_MS + 1), null);
});

test('leads e unidades não se misturam', () => {
  limparNaoEntregues();
  marcarNaoEntregue('u1', 100, 'do lead 100');
  assert.equal(consumirNaoEntregue('u1', 200), null);
  assert.equal(consumirNaoEntregue('u2', 100), null);
  assert.equal(consumirNaoEntregue('u1', 100), 'do lead 100');
});

test('texto vazio não vira aviso', () => {
  limparNaoEntregues();
  marcarNaoEntregue('u1', 100, '   ');
  assert.equal(consumirNaoEntregue('u1', 100), null);
});

test('o bloco proíbe o "como eu falei"', () => {
  const b = renderEntregaFalha('A consulta é R$ 350.');
  assert.match(b, /NÃO chegou/);
  assert.match(b, /como eu falei/);
  assert.match(b, /R\$ 350/);
});

test('sem falha, nenhum bloco', () => {
  assert.equal(renderEntregaFalha(null), '');
});

test('texto longo é cortado pra não inchar o prompt', () => {
  const b = renderEntregaFalha('x'.repeat(500));
  assert.ok(b.length < 700, `bloco grande demais: ${b.length}`);
  assert.match(b, /…/);
});
