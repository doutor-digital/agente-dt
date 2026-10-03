import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lerTurnos, profissionalDoHorario } from './profissional-por-turno.js';

const ESCALA = [
  { inicio: '08:00', fim: '13:30', idStaff: 536, nome: 'Dra. Juliana Santos' },
  { inicio: '14:00', fim: '19:30', idStaff: 704, nome: 'Dra. Mariane Gomes' },
];

test('bordas: o turno começa no início e a consulta tem que começar antes do fim', () => {
  assert.equal(profissionalDoHorario(ESCALA, '08:00')?.idStaff, 536);
  assert.equal(profissionalDoHorario(ESCALA, '13:00')?.idStaff, 536);
  assert.equal(profissionalDoHorario(ESCALA, '13:30'), null);
  assert.equal(profissionalDoHorario(ESCALA, '14:00')?.idStaff, 704);
  assert.equal(profissionalDoHorario(ESCALA, '19:00')?.idStaff, 704);
  assert.equal(profissionalDoHorario(ESCALA, '19:30'), null);
  assert.equal(profissionalDoHorario(ESCALA, '07:30'), null);
});

test('aceita "HH:MM:SS" e descarta configuração quebrada', () => {
  assert.equal(profissionalDoHorario(ESCALA, '09:30:00')?.nome, 'Dra. Juliana Santos');
  assert.deepEqual(lerTurnos(null), []);
  assert.deepEqual(lerTurnos([{ inicio: '8h', fim: '12:00', idStaff: 1, nome: 'x' }, { inicio: '08:00', fim: '12:00', idStaff: 0, nome: 'x' }]), []);
  assert.equal(profissionalDoHorario('lixo', '09:00'), null);
  assert.equal(profissionalDoHorario(ESCALA, 'nove'), null);
});
