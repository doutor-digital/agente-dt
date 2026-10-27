import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PADROES_FALHA, PADROES_VAZAMENTO, classificarMensagem, totalDeSinais } from './sinais.js';
import { final4, limparTrecho, primeiroNome } from './privacidade.js';

test('vazamento de raciocínio: pega as frases do João, ignora conversa normal', () => {
  for (const frase of [
    'Vou acolher a dor dele antes de falar de preço.',
    'O paciente ainda não disse onde sente dor.',
    'Antes de soltar o valor, preciso entender o quadro.',
    'VOU ACOLHER primeiro',
  ]) {
    assert.equal(classificarMensagem(frase).vazamento, true, frase);
  }
  for (const frase of [
    'Entendo, deve ser difícil. Onde exatamente você sente a dor?',
    'O valor da consulta é R$ 250,00.',
    'Vou verificar a agenda para você.',
  ]) {
    assert.equal(classificarMensagem(frase).vazamento, false, frase);
  }
});

test('falha admitida: "não consegui abrir", "instabilidade", "não entendi"', () => {
  for (const frase of ['Não consegui abrir o seu áudio.', 'Estamos com uma instabilidade no sistema.', 'Desculpe, não entendi.']) {
    assert.equal(classificarMensagem(frase).falha, true, frase);
  }
  assert.equal(classificarMensagem('Perfeito, te espero amanhã às 14h.').falha, false);
});

test('todo padrão da lista pega o próprio texto e compila igual no JavaScript e no Postgres (só a parte comum)', () => {
  for (const p of [...PADROES_VAZAMENTO, ...PADROES_FALHA]) {
    // Construções que o Postgres não lê igual: lookaround, \m, (?i), referência nomeada.
    assert.doesNotMatch(p, /\(\?|\\m|\\M|\\y/, `padrão com sintaxe só de JS: ${p}`);
    const exemplo = p.replace(/\(([^)|]+)\|([^)]+)\)/g, '$1').replace(/\(/g, '').replace(/\)/g, '');
    assert.ok(new RegExp(p, 'i').test(exemplo), `o padrão "${p}" não pega nem o próprio exemplo "${exemplo}"`);
  }
});

test('total de sinais soma as três categorias', () => {
  assert.equal(totalDeSinais({ repetidas: 3, vazamento: 2, falha: 7 }), 12);
});

test('privacidade: 1º nome, 4 últimos dígitos, trecho sem número', () => {
  assert.equal(primeiroNome('Maria Aparecida da Silva'), 'Maria');
  assert.equal(primeiroNome('  joão  '), 'joão');
  assert.equal(primeiroNome('5511999998888'), null, 'telefone no lugar do nome não é nome');
  assert.equal(primeiroNome(null), null);
  assert.equal(primeiroNome(''), null);

  assert.equal(final4('+55 (11) 99999-8888'), '8888');
  assert.equal(final4('12'), null);
  assert.equal(final4(null), null);

  const t = limparTrecho('Meu zap é 11 99999-8888 e o outro +5511988887777, ok?');
  assert.doesNotMatch(t, /\d{4}/);
  assert.match(t, /\[número\]/);
  assert.equal(limparTrecho('R$ 250,00 no Pix'), 'R$ 250,00 no Pix', 'preço não é telefone');
  assert.ok(limparTrecho('a'.repeat(300)).length <= 140);
});
