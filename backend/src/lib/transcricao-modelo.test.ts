import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ehEcoDeInstrucao, INSTRUCAO_ANTIGA_DE_TRANSCRICAO } from './transcricao-modelo.js';

// Caxias, lead 2823748, 13/11/2026: o áudio mudo voltou como o próprio texto de instrução, gravado como fala do paciente.
const TRANSCRICAO_REAL =
  'Paciente brasileiro falando com uma clínica de fisioterapia e reabilitação ortopédica. Assuntos comuns: dor na coluna, lombar, ombro, joelho, quadril, hérnia de disco, fisioterapia, pilates, consulta, agendamento, valor.';

test('o eco inteiro da instrução é descartado', () => {
  assert.equal(ehEcoDeInstrucao(TRANSCRICAO_REAL, INSTRUCAO_ANTIGA_DE_TRANSCRICAO), true);
});

test('eco parcial, com outra caixa/pontuação ou só a 1ª frase, também', () => {
  assert.equal(ehEcoDeInstrucao('paciente brasileiro falando com uma clinica de fisioterapia e reabilitacao ortopedica', INSTRUCAO_ANTIGA_DE_TRANSCRICAO), true);
  assert.equal(ehEcoDeInstrucao('Assuntos comuns: dor na coluna, lombar, ombro, joelho, quadril, hérnia de disco.', INSTRUCAO_ANTIGA_DE_TRANSCRICAO), true);
  assert.equal(ehEcoDeInstrucao(TRANSCRICAO_REAL.replace('Paciente', 'O paciente'), INSTRUCAO_ANTIGA_DE_TRANSCRICAO), true);
});

test('fala de paciente nunca é eco, mesmo repetindo palavras da instrução', () => {
  for (const f of [
    'dor na lombar',
    'Oi, tenho dor na coluna e no joelho, queria marcar uma consulta e saber o valor',
    'Bom dia, sou paciente e queria saber o valor da consulta de fisioterapia, tenho hérnia de disco na lombar',
    'Estou com dor no ombro e na coluna há três meses, queria agendar uma avaliação',
    '',
  ]) {
    assert.equal(ehEcoDeInstrucao(f, INSTRUCAO_ANTIGA_DE_TRANSCRICAO), false, f);
  }
});
