import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonimizar } from './anonimizar.js';

test('tira telefone em vários formatos', () => {
  for (const f of ['(21) 98472-5300', '21984725300', '+55 21 98472-5300', '55 21 98472 5300']) {
    assert.ok(!/\d{4}/.test(anonimizar(`me liga no ${f} por favor`)), f);
    assert.match(anonimizar(`me liga no ${f}`), /\[(telefone|documento)\]/); // 11 dígitos colados também parecem CPF: sai do mesmo jeito
  }
});

test('tira e-mail e CPF', () => {
  const t = anonimizar('meu email é maria.souza@gmail.com e meu cpf 123.456.789-09');
  assert.ok(!t.includes('@') && !t.includes('123.456'));
  assert.match(t, /\[e-mail\]/);
  assert.match(t, /\[documento\]/);
});

test('troca o nome do paciente, inteiro ou só uma parte, sem mexer em outras palavras', () => {
  const t = anonimizar('Oi, aqui é a Maria Souza. A Mariana já veio? Souza é meu sobrenome.', ['Maria Souza']);
  assert.ok(!/Maria(?!na)/.test(t) && !/Souza/.test(t));
  assert.match(t, /Mariana/, 'outra pessoa com nome parecido não pode ser trocada');
});

test('ignora partículas e número no título do cartão', () => {
  const t = anonimizar('Vou de carro e depois do almoço eu chego', ['Lead 2040118 de Silva']);
  assert.ok(t.includes('de carro') && t.includes('depois do almoço'));
});

test('sem nome e sem dado pessoal devolve igual', () => {
  assert.equal(anonimizar('Dor lombar desde segunda'), 'Dor lombar desde segunda');
});
