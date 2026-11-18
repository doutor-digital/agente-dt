import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guardarStatusDoPrompt, guardarStatusDoTurno, pegarStatusDoTurno, statusDoPacienteDoPrompt } from './revisora-de-saida-contexto.js';

test('status: prompt do paciente em tratamento (texto do renderPacienteNaFranquia)', () => {
  const s = statusDoPacienteDoPrompt('x\n- Este paciente JÁ TEM TRATAMENTO na clínica (fechado ou em andamento).\n- Já foi atendido: consulta de retorno em 02/11.\n');
  assert.equal(s.emTratamento, true);
  assert.equal(s.jaAtendido, true);
  assert.equal(s.consultaMarcada, null);
});

test('status: funil TRATAMENTO (REGRAS_DO_FUNIL_TRATAMENTO) também é em tratamento', () => {
  assert.equal(statusDoPacienteDoPrompt('- ELE ESTÁ EM TRATAMENTO (funil TRATAMENTO). Sessão...').emTratamento, true);
});

test('status: bloco da consulta de pé vira o texto da consulta marcada', () => {
  const s = statusDoPacienteDoPrompt('<consulta_do_paciente>\nConsulta CONFIRMADA agora no sistema da clínica: **quinta, 20/11 às 10h**\n</consulta_do_paciente>');
  assert.equal(s.emTratamento, false);
  assert.match(s.consultaMarcada ?? '', /quinta, 20\/11 às 10h/);
});

test('status: consulta desmarcada/sem consulta não conta; prompt vazio ou nulo é tudo falso', () => {
  const nada = { emTratamento: false, jaAtendido: false, consultaMarcada: null };
  assert.deepEqual(statusDoPacienteDoPrompt('<consulta_do_paciente>\nDESMARCADA\n</consulta_do_paciente>'), nada);
  assert.deepEqual(statusDoPacienteDoPrompt(''), nada);
  assert.deepEqual(statusDoPacienteDoPrompt(null), nada);
  assert.deepEqual(statusDoPacienteDoPrompt(undefined), nada);
});

test('a ponte do grafo: guarda por traceId, consome uma vez só e expira', () => {
  const st = { emTratamento: true, jaAtendido: false, consultaMarcada: null };
  guardarStatusDoTurno('t1', st, 1_000);
  assert.deepEqual(pegarStatusDoTurno('t1', 2_000), st);
  assert.equal(pegarStatusDoTurno('t1', 2_000), null, 'consumida');
  guardarStatusDoTurno('t2', st, 1_000);
  assert.equal(pegarStatusDoTurno('t2', 1_000 + 11 * 60_000), null, 'passou da validade');
  assert.equal(pegarStatusDoTurno('nunca-guardado'), null);
});

test('guardar velho limpa os vencidos (a ponte não cresce sem fim)', () => {
  const st = { emTratamento: false, jaAtendido: false, consultaMarcada: null };
  guardarStatusDoTurno('velho', st, 1_000);
  guardarStatusDoTurno('novo', st, 1_000 + 11 * 60_000);
  assert.equal(pegarStatusDoTurno('velho', 1_000 + 11 * 60_000), null);
  assert.deepEqual(pegarStatusDoTurno('novo', 1_000 + 11 * 60_000), st);
});

test('guardarStatusDoPrompt nunca lança, nem com lixo', () => {
  assert.doesNotThrow(() => guardarStatusDoPrompt('t3', null));
  assert.doesNotThrow(() => guardarStatusDoPrompt('t4', { toString: () => { throw new Error('x'); } } as unknown as string));
  pegarStatusDoTurno('t3');
});
