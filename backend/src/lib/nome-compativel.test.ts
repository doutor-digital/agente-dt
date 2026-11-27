/** "Mesma pessoa?" pelo nome E sobrenome — o que decide se o lead achado pelo telefone pode virar o paciente da consulta. Na dúvida, NÃO. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nomesCompletosCompativeis, palavrasDoNome } from './nome-compativel.js';

test('mesmo nome e mesmo sobrenome casam, sem acento, caixa, pontuação, partícula nem nome do meio', () => {
  assert.equal(nomesCompletosCompativeis('Maria da Silva', 'maria SILVA'), true);
  assert.equal(nomesCompletosCompativeis('José Carlos de Souza', 'JOSE CARLOS SOUZA'), true);
  assert.equal(nomesCompletosCompativeis('Maria Souza', 'MARIA  souza'), true);
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

test('nomes do meio: só casa com o MESMO conjunto (um em comum não basta — "Lima" pode ser da família)', () => {
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Souza', 'Maria Eduarda Souza'), false);
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Souza', 'Maria Aparecida Lima Souza'), false);
  // mãe "Maria Aparecida Lima Souza"; filha agendando com o sobrenome da família no meio (sonda do sênior, 27/11)
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Lima Souza', 'Maria Lima Souza'), false);
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Lima Souza', 'Maria Eduarda Lima Souza'), false);
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Lima Souza', 'MARIA APARECIDA LIMA SOUZA'), true);
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Lima Souza', 'Maria Lima Aparecida Souza'), true);
});

test('nome do meio de UM lado só NÃO casa (o lead que criamos quase sempre tem 2 palavras; filho com nome composto é o caso comum)', () => {
  assert.equal(nomesCompletosCompativeis('Maria Eduarda Souza', 'Maria Souza'), false);
  assert.equal(nomesCompletosCompativeis('João Pedro Santos', 'João Santos'), false);
  assert.equal(nomesCompletosCompativeis('Maria Souza', 'Maria José Souza'), false);
  assert.equal(nomesCompletosCompativeis('Maria Aparecida Souza', 'Maria Souza'), false);
  assert.equal(nomesCompletosCompativeis('José Carlos de Souza', 'JOSE C. SOUZA'), false);
});

test('sufixo de geração / parentesco de UM lado só NÃO casa: "Maria Souza Filha" não é "Maria Souza"', () => {
  assert.equal(nomesCompletosCompativeis('Maria Souza Filha', 'Maria Souza'), false);
  assert.equal(nomesCompletosCompativeis('Maria Souza', 'Maria Souza Filha'), false);
  assert.equal(nomesCompletosCompativeis('Pedro Silva Neto', 'Pedro Silva'), false);
  assert.equal(nomesCompletosCompativeis('Carlos Souza Júnior', 'Carlos Souza'), false);
  assert.equal(nomesCompletosCompativeis('Ana Lima Sobrinha', 'Ana Lima'), false);
  assert.equal(nomesCompletosCompativeis('Maria Souza Neta', 'Maria Souza'), false);
  assert.equal(nomesCompletosCompativeis('Tia Ana Lima', 'Ana Lima'), false);
  assert.equal(nomesCompletosCompativeis('Maria Souza Filha', 'maria souza FILHA'), true, 'a mesma marca dos dois lados casa');
});

test('apelido que também é sufixo ("Junior", "Neto") como PRIMEIRA palavra é nome, não sufixo: "Junior Santos" casa com "Junior Santos"', () => {
  assert.equal(nomesCompletosCompativeis('Junior Santos', 'JUNIOR SANTOS'), true);
  assert.equal(nomesCompletosCompativeis('Neto Silva', 'Neto Silva'), true);
  assert.equal(nomesCompletosCompativeis('Junior Santos', 'Carlos Santos Junior'), false);
});
