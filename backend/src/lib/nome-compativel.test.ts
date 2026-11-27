/** "Mesma pessoa?" pelo primeiro nome — o que decide se o lead achado pelo telefone vira o lead do cartão. Na dúvida, NÃO. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nomesCompativeis, primeiroNomeNormalizado } from './nome-compativel.js';

test('mesmo primeiro nome, sem acento, caixa ou pontuação, casa — o sobrenome não entra', () => {
  assert.equal(nomesCompativeis('Maria da Silva', 'maria Souza Lima'), true);
  assert.equal(nomesCompativeis('José Carlos', 'JOSE'), true);
  assert.equal(nomesCompativeis('Ana-Clara Dias', 'Ana'), false, 'hífen funde as palavras (anaclara): outro nome');
  assert.equal(nomesCompativeis('  Joana ', 'Joana❤️'), true);
});

test('mãe e filha NÃO casam', () => {
  assert.equal(nomesCompativeis('Joana Souza Lima', 'Maria da Silva'), false);
  assert.equal(nomesCompativeis('Mariana Souza', 'Maria Souza'), false);
});

test('sem nome, provisório ou curto demais: nunca casa (nem consigo mesmo)', () => {
  assert.equal(nomesCompativeis(null, 'Maria'), false);
  assert.equal(nomesCompativeis('Maria', undefined), false);
  assert.equal(nomesCompativeis('', ''), false);
  assert.equal(nomesCompativeis('Paciente WhatsApp (final 7777)', 'Paciente WhatsApp (final 7777)'), false);
  assert.equal(nomesCompativeis('A. Silva', 'A. Souza'), false);
  assert.equal(primeiroNomeNormalizado('123 456'), null);
});

test('tratamento e parentesco não são nome: "Dona Maria" × "Dona Ana" NÃO casam, e "Dona Maria" casa com "Maria"', () => {
  assert.equal(nomesCompativeis('Dona Maria', 'Dona Ana'), false);
  assert.equal(nomesCompativeis('Dr. João Souza', 'Dra. Joana Souza'), false);
  assert.equal(nomesCompativeis('Mãe', 'Mãe da Ana'), false, 'só parentesco: não há nome para comparar');
  assert.equal(nomesCompativeis('Dona Maria', 'Maria da Silva'), true);
  assert.equal(primeiroNomeNormalizado('Sra. Ana'), 'ana');
});
