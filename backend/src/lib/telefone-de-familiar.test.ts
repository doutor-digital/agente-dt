/**
 * Caso Aline × Nilson (Olímpia, 21/10/2026, leads 5441607 e 5734865): a esposa mandou o celular do marido no chat
 * dela; a equipe escreveu para o número e o Kommo abriu um cartão novo e vazio. O número tem de virar contato do
 * cartão dela — só quando a mensagem diz de quem é.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatosDoCelular,
  nomeDoContatoNovo,
  nomeDoTitulo,
  normalizarCelular,
  telefoneDeFamiliar,
  textoDaNota,
} from './telefone-de-familiar.js';
import { AUTOMACOES, verificarCatalogo } from './automacoes.js';

test('caso Aline: número numa mensagem e "é dele" na seguinte', () => {
  const falas = ['Bom dia', '17991135549', 'Esse é o número dele, se puder mandar msg para ele por favor'];
  assert.equal(telefoneDeFamiliar(falas), '5517991135549');
  // antes do "é dele" chegar, nada
  assert.equal(telefoneDeFamiliar(['Bom dia', '17991135549']), null);
});

test('formatos com espaço, traço, parênteses e +55 dão o mesmo número', () => {
  for (const t of [
    'o número do meu marido é (17) 99113-5549',
    'segue o contato: +55 17 99113 5549',
    'liga pra ele: 17 9 9113-5549',
    'esse é o whats da minha mãe 17991135549',
  ]) {
    assert.equal(telefoneDeFamiliar([t]), '5517991135549', t);
  }
});

test('número antigo, sem o nono dígito, ganha o 9', () => {
  assert.equal(telefoneDeFamiliar(['o número dela é 17 9113-5549']), '5517991135549');
});

test('sem dizer de quem é, número solto não entra', () => {
  for (const t of ['17991135549', 'meu outro número é 17991135549', 'pode me ligar no 17 99113-5549']) {
    assert.equal(telefoneDeFamiliar([t]), null, t);
  }
});

test('CPF, Pix e carteirinha não são telefone', () => {
  assert.equal(telefoneDeFamiliar(['o CPF dele é 17991135549']), null);
  assert.equal(telefoneDeFamiliar(['a chave pix dele é 17991135549']), null);
  // CPF válido que parece celular de DDD 17 (e sem a palavra CPF): o dígito verificador barra
  assert.equal(telefoneDeFamiliar(['o dele é 17991135586']), null);
});

test('dois números diferentes: não dá para saber qual, não faz nada', () => {
  assert.equal(telefoneDeFamiliar(['o dele é 17991135549 ou 17988881234']), null);
  // o mesmo número escrito duas vezes conta como um
  assert.equal(telefoneDeFamiliar(['17991135549', 'isso, 17 99113-5549 é o dele']), '5517991135549');
});

test('fixo, DDD que não existe e número sem DDD ficam de fora', () => {
  assert.equal(normalizarCelular('1733224455'), null); // fixo
  assert.equal(normalizarCelular('20991135549'), null); // DDD 20 não existe
  assert.equal(normalizarCelular('991135549'), null); // sem DDD
  assert.equal(normalizarCelular('+55 (17) 99113-5549'), '5517991135549');
});

test('grava com e sem o nono dígito', () => {
  assert.deepEqual(formatosDoCelular('5517991135549'), ['+55 17 99113-5549', '+55 17 9113-5549']);
});

test('o nome do contato novo vem do título quando o título é o paciente', () => {
  assert.equal(nomeDoTitulo('Nilson Nunes da Silva 15/10/2026'), 'Nilson Nunes da Silva');
  assert.equal(nomeDoTitulo('Lead #5734865'), null);
  assert.equal(nomeDoContatoNovo('Nilson Nunes da Silva 15/10/2026', 'Aline'), 'Nilson Nunes da Silva');
  // título com o nome de quem escreve não serve
  assert.equal(nomeDoContatoNovo('Aline Souza 15/10/2026', 'Aline'), 'Telefone enviado por Aline');
  assert.equal(nomeDoContatoNovo(null, null), 'Telefone enviado no chat');
});

test('a nota diz o que foi feito e pede Mesclar quando o número já tem cartão', () => {
  const n = textoDaNota({ formatado: '+55 17 99113-5549', remetente: 'Aline', contatoNovo: false, outrosCartoes: [5734865] });
  assert.ok(n.includes('Aline'));
  assert.ok(n.includes('+55 17 99113-5549'));
  assert.ok(n.includes('5734865'));
  assert.ok(n.includes('Mesclar'));
});

test('a chave está no catálogo e nasce em só no papel', () => {
  const a = AUTOMACOES.find((x) => x.id === 'telefone-de-familiar');
  assert.ok(a);
  assert.equal(a.quandoVazio, 'seco');
  assert.equal(a.temSeco, true);
  assert.deepEqual(verificarCatalogo(), []);
});
