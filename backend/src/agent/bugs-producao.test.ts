import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeName, detectNameDisclosure } from './name-capture.js';
import { splitIntoChunks } from '../services/kommo.service.js';

/**
 * Regressões de dois bugs que chegaram ao paciente na Imperatriz em
 * 21/08/2026. Estão juntos aqui de propósito: são o mesmo tipo de falha —
 * heurística que parecia razoável e desandou num caso real.
 */

// --------------------------------------------------------------------------
// BUG 1 — frase partida ao meio entre dois balões.
// O paciente recebeu "...segurar o próprio peso na" e, depois, "perna? E
// chegou...". A única fronteira de frase da janela caiu abaixo do piso e o
// código cortou num espaço qualquer.
// --------------------------------------------------------------------------

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
  // O incidente real tinha o ponto final aos 75 de 240 chars (31%) — dentro do
  // piso antigo de 35%, ou seja, descartado. Este é o caso que voltou a passar.
  const primeira = 'Poxa, isso é algo importante de avaliar com bastante atenção hoje.'; // ~65
  const texto = primeira + ' ' + 'seguindo com um texto corrido bem longo '.repeat(6);
  const pedacos = splitIntoChunks(texto, 240);
  assert.equal(pedacos[0].trim(), primeira, 'devia ter cortado no ponto final');
});

test('texto sem fronteira nenhuma ainda não racha palavra ao meio', () => {
  // Palavras distintas: assim dá pra afirmar que o pedaço termina numa palavra
  // COMPLETA, e não no meio de uma.
  const palavras = Array.from({ length: 90 }, (_, i) => `palavra${i}`);
  const texto = palavras.join(' ');
  for (const p of splitIntoChunks(texto, 240)) {
    const ultima = p.trim().split(/\s+/).pop() ?? '';
    assert.ok(palavras.includes(ultima), `terminou no meio de uma palavra: "${ultima}"`);
  }
});

// --------------------------------------------------------------------------
// BUG 2 — a queixa do paciente virou o nome do lead.
// O card foi salvo como "Fraqueza Nas Pernas 21/08/2026".
// --------------------------------------------------------------------------

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
  // É exatamente o cenário do incidente: pergunta de nome ficou pendente e o
  // paciente respondeu sobre o sintoma (a um atendente humano).
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
  // Nomes reais que poderiam colidir com a lista se ela fosse ampla demais.
  for (const nome of ['Douglas', 'Doriana', 'Bracco', 'Perna Vieira Filho'.split(' ')[1]]) {
    assert.equal(looksLikeName(nome), true, `barrou nome legítimo: "${nome}"`);
  }
});
