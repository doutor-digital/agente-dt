import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  registrarGasto,
  conferirTeto,
  marcarAvisado,
  conversasMaisCaras,
  _resetarGastos,
} from './teto-conversa.js';

/**
 * Havia teto por chamada e orçamento mensal por unidade — mas o mensal só
 * pintava aviso no painel, sem bloquear nada. Faltava o do meio: a conversa que
 * sozinha queima o orçamento do mês, um turno barato de cada vez.
 */

const CONVERSA = 'unit-doutor-hernia-porto-lead-24405762';
const OUTRA = 'unit-doutor-hernia-porto-lead-24322324';

beforeEach(() => _resetarGastos());

test('conversa nova começa do zero e não estoura', () => {
  const v = conferirTeto(CONVERSA, 1.5);
  assert.equal(v.estourou, false);
  assert.equal(v.usd, 0);
  assert.equal(v.turnos, 0);
});

test('o gasto acumula turno a turno', () => {
  registrarGasto(CONVERSA, 0.2);
  registrarGasto(CONVERSA, 0.3);

  const v = conferirTeto(CONVERSA, 1.5);
  assert.equal(Number(v.usd.toFixed(2)), 0.5);
  assert.equal(v.turnos, 2);
  assert.equal(v.estourou, false, 'uso normal não pode ser cortado');
});

test('estoura quando passa do teto', () => {
  for (let i = 0; i < 8; i++) registrarGasto(CONVERSA, 0.2);
  assert.equal(conferirTeto(CONVERSA, 1.5).estourou, true);
});

test('uma conversa cara não afeta a outra', () => {
  for (let i = 0; i < 10; i++) registrarGasto(CONVERSA, 0.2);
  registrarGasto(OUTRA, 0.1);

  assert.equal(conferirTeto(CONVERSA, 1.5).estourou, true);
  assert.equal(conferirTeto(OUTRA, 1.5).estourou, false);
});

test('o aviso sai uma vez, não a cada turno', () => {
  registrarGasto(CONVERSA, 2);
  assert.equal(marcarAvisado(CONVERSA), true, 'primeira vez avisa');
  assert.equal(marcarAvisado(CONVERSA), false, 'repetir vira ruído');
});

test('valor inválido não corrompe a conta', () => {
  registrarGasto(CONVERSA, Number.NaN);
  registrarGasto(CONVERSA, -5);
  registrarGasto('', 10);

  assert.equal(conferirTeto(CONVERSA, 1.5).usd, 0);
});

test('o retrato mostra a conversa mais cara primeiro', () => {
  registrarGasto(OUTRA, 0.1);
  registrarGasto(CONVERSA, 0.9);

  const top = conversasMaisCaras(5);
  assert.equal(top[0].threadId, CONVERSA);
  assert.equal(top[0].usd, 0.9);
});

test('o teto é generoso: uso normal de uma conversa longa não bate nele', () => {
  // Vinte turnos de conversa real, com prompt grande e cache funcionando.
  for (let i = 0; i < 20; i++) registrarGasto(CONVERSA, 0.02);
  const v = conferirTeto(CONVERSA, 1.5);

  assert.equal(v.estourou, false, 'pegar caso patológico, nunca atendimento normal');
  assert.ok(v.usd < 0.5);
});

test('avisa ao passar de 60% do teto, antes de cortar ninguém', () => {
  // Serve pra descobrir calibragem errada no log, não no paciente.
  for (let i = 0; i < 5; i++) registrarGasto(CONVERSA, 0.2);

  const v = conferirTeto(CONVERSA, 1.5);
  assert.equal(v.estourou, false, 'passar de 60% não pode cortar');
  assert.ok(v.usd >= 1.5 * 0.6);
});
