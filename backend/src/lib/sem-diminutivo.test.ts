import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semDiminutivo, temDiminutivo } from './sem-diminutivo.js';

test('a mensagem real da Serra que o João apontou', () => {
  const entrada =
    'Ainda separei dois horarinhos bem tranquilos pra te encaixar essa semana 😊 ' +
    'Prefere de manhã ou à tarde? Me diga e eu já reservo certinho pra você';
  assert.equal(
    semDiminutivo(entrada),
    'Ainda separei dois horários bem tranquilos pra te encaixar essa semana 😊 ' +
      'Prefere de manhã ou à tarde? Me diga e eu já reservo certo pra você',
  );
});

test('carteirinha NÃO é diminutivo — é o convênio, e a gente precisa dela', () => {
  const t = 'Com a carteirinha do plano a consulta fica R$ 150.';
  assert.equal(semDiminutivo(t), t);
  assert.equal(temDiminutivo(t), false);
});

test('nome de gente não vira outra coisa', () => {
  // Terezinha, Agostinho e Coutinho apareceram na medição de 30 dias.
  for (const t of [
    'A Terezinha já está confirmada para amanhã.',
    'Falei com o Agostinho sobre o horário.',
    'O Dr. Coutinho atende à tarde.',
    'Sua sobrinha também pode vir?',
  ]) {
    assert.equal(semDiminutivo(t), t, t);
  }
});

test('palavra correta que só parece diminutivo continua inteira', () => {
  for (const t of [
    'Já te encaminho o endereço.',
    'Te mando uma figurinha com o mapa.',
    'A clínica fica no caminho do postinho.',
    'Toque a campainha quando chegar.',
  ]) {
    assert.equal(semDiminutivo(t), t, t);
  }
});

test('plural não deixa letra sobrando', () => {
  assert.equal(semDiminutivo('Os horarinhos estão guardadinhos.'), 'Os horários estão guardados.');
  assert.equal(semDiminutivo('Deixei dois certinhos.'), 'Deixei dois certos.');
});

test('mantém a caixa da palavra original', () => {
  assert.equal(semDiminutivo('Certinho, te espero amanhã!'), 'Certo, te espero amanhã!');
  assert.equal(semDiminutivo('CERTINHO!'), 'CERTO!');
});

test('gênero é preservado', () => {
  assert.equal(semDiminutivo('Sua vaga está reservadinha.'), 'Sua vaga está reservada.');
  assert.equal(semDiminutivo('Seu horário está reservadinho.'), 'Seu horário está reservado.');
});

test('acento entra certo onde a palavra normal tem', () => {
  assert.equal(semDiminutivo('É rapidinho, viu?'), 'É rápido, viu?');
  assert.equal(semDiminutivo('Tenho um horariozinho às 9h.'), 'Tenho um horário às 9h.');
});

test('texto limpo passa intacto e não é marcado', () => {
  const t = 'A consulta é R$ 350 no dia, ou R$ 250 pagando antes por Pix. Chegue 15 minutos antes.';
  assert.equal(semDiminutivo(t), t);
  assert.equal(temDiminutivo(t), false);
});

test('texto vazio não quebra', () => {
  assert.equal(semDiminutivo(''), '');
});
