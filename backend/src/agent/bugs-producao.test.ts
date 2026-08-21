import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeName, detectNameDisclosure } from './name-capture.js';
import { splitIntoChunks } from '../services/kommo.service.js';

const MENSAGEM_REAL =
  'Poxa, fraqueza nas pernas é algo importante de avaliar com bastante atenção. ' +
  'Só pra eu entender direitinho: essa fraqueza tem piorado progressivamente, ou você ' +
  'já perdeu força a ponto de ter dificuldade pra segurar o próprio peso na perna? ' +
  'E chegou a notar alguma perda de controle pra fazer xixi ou ir ao banheiro?';

test('nenhum pedaço termina no meio de uma frase', () => {
  const pedacos = splitIntoChunks(MENSAGEM_REAL, 240);
  for (const p of pedacos.slice(0, -1)) {
    assert.match(
      p.trim(),
      /[.!?:]$/,
      `pedaço terminou no meio da frase: "...${p.trim().slice(-40)}"`,
    );
  }
});

test('o texto inteiro sobrevive à quebra, sem perder nem duplicar palavra', () => {
  const junto = splitIntoChunks(MENSAGEM_REAL, 240).join(' ').replace(/\s+/g, ' ');
  assert.equal(junto, MENSAGEM_REAL.replace(/\s+/g, ' '));
});

test('fronteira de frase aos ~30% da janela é aceita (era o caso que quebrou)', () => {
  const primeira = 'Poxa, isso é algo importante de avaliar com bastante atenção hoje.';
  const texto = primeira + ' ' + 'seguindo com um texto corrido bem longo '.repeat(6);
  const pedacos = splitIntoChunks(texto, 240);
  assert.equal(pedacos[0].trim(), primeira, 'devia ter cortado no ponto final');
});

test('texto sem fronteira nenhuma ainda não racha palavra ao meio', () => {
  const palavras = Array.from({ length: 90 }, (_, i) => `palavra${i}`);
  const texto = palavras.join(' ');
  for (const p of splitIntoChunks(texto, 240)) {
    const ultima = p.trim().split(/\s+/).pop() ?? '';
    assert.ok(palavras.includes(ultima), `terminou no meio de uma palavra: "${ultima}"`);
  }
});

test('queixa clínica NUNCA é aceita como nome', () => {
  const queixas = [
    'Fraqueza nas pernas',
    'Dor na coluna',
    'Hérnia de disco',
    'dor lombar',
    'formigamento no braço',
    'dor no joelho',
  ];
  for (const q of queixas) {
    assert.equal(looksLikeName(q), false, `aceitou queixa como nome: "${q}"`);
  }
});

test('mesmo com a IA tendo perguntado o nome, a queixa não é capturada', () => {
  const r = detectNameDisclosure('Fraqueza nas pernas', { nameWasAsked: true });
  assert.equal(r, null);
});

test('nome de gente continua sendo capturado normalmente', () => {
  assert.equal(looksLikeName('Adilson Alves'), true);
  assert.equal(looksLikeName('Maria'), true);
  assert.equal(looksLikeName('Ana Paula de Souza'), true);
  assert.equal(detectNameDisclosure('Adilson', { nameWasAsked: true }), 'Adilson');
  assert.equal(detectNameDisclosure('meu nome é Carlos Silva'), 'Carlos Silva');
});

test('nome legítimo não é barrado por acaso', () => {
  for (const nome of ['Douglas', 'Doriana', 'Bracco', 'Perna Vieira Filho'.split(' ')[1]]) {
    assert.equal(looksLikeName(nome), true, `barrou nome legítimo: "${nome}"`);
  }
});
