/** "Mesma pessoa?" pelo nome E sobrenome — o que decide se o lead achado pelo telefone pode virar o paciente da consulta. Na dúvida, NÃO. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nomesCompletosCompativeis, palavrasDoNome } from './nome-compativel.js';

test('mesmo nome e mesmo sobrenome casam, sem acento, caixa, pontuação, partícula nem nome do meio', () => {
  assert.equal(nomesCompletosCompativeis('Maria da Silva', 'maria SILVA'), true);
  assert.equal(nomesCompletosCompativeis('Maria Souza', 'Maria José Souza'), true);
  assert.equal(nomesCompletosCompativeis('José Carlos de Souza', 'JOSE C. SOUZA'), true);
});

test('só o primeiro nome igual NÃO basta: "Maria José Souza" × "Maria Aparecida" não casa', () => {
  assert.equal(nomesCompletosCompativeis('Maria José Souza', 'Maria Aparecida'), false);
  assert.equal(nomesCompletosCompativeis('Maria Souza', 'Maria Lima'), false);
});

test('mãe e filha NÃO casam', () => {
  assert.equal(nomesCompletosCompativeis('Joana Souza Lima', 'Maria da Silva'), false);
  assert.equal(nomesCompletosCompativeis('Joana Souza Lima', 'Maria Souza Lima'), false);
});

test('sem sobrenome (um lado só com o primeiro nome), ausente ou provisório: nunca casa — nem consigo mesmo', () => {
  assert.equal(nomesCompletosCompativeis('Maria', 'Maria'), false);
  assert.equal(nomesCompletosCompativeis('Maria Souza', 'Maria'), false);
  assert.equal(nomesCompletosCompativeis(null, 'Maria Souza'), false);
  assert.equal(nomesCompletosCompativeis('Maria Souza', undefined), false);
  assert.equal(nomesCompletosCompativeis('', ''), false);
  assert.equal(nomesCompletosCompativeis('Paciente WhatsApp (final 7777)', 'Paciente WhatsApp (final 7777)'), false);
});

test('tratamento, parentesco e partícula não são nome: "Mãe da Ana" × "Tia da Ana" não casa pelo "da"', () => {
  assert.equal(nomesCompletosCompativeis('Mãe da Ana', 'Tia da Ana'), false);
  assert.equal(nomesCompletosCompativeis('Dona Maria Souza', 'Dona Ana Souza'), false);
  assert.equal(nomesCompletosCompativeis('Dona Maria Souza', 'Maria Souza'), true);
  assert.deepEqual(palavrasDoNome('Mãe da Ana'), ['ana']);
  assert.deepEqual(palavrasDoNome('A. Silva'), ['silva']);
});

test('mãe e filha com o MESMO nome e sobrenome mas nome do meio diferente NÃO casam; sem nome do meio de um lado, casa', () => {
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Souza', 'Maria Eduarda Souza'), false);
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Souza', 'Maria Aparecida Lima Souza'), true);
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Souza', 'Maria Souza'), true);
});
