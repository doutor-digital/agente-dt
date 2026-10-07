import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartaoTemConsulta } from './agendamento-perdido-worker.js';

const comData = (segundos: unknown, nome = '◷ Data da Consulta') => ({
  custom_fields_values: [{ field_id: 1, field_name: nome, values: [{ value: segundos }] }],
});

// 06/10/2026 10:14 BRT — a oferta do lead 28088906 da Açailândia
const oferta = new Date('2026-10-06T13:14:09Z');

test('consulta marcada depois da oferta: não é agendamento perdido', () => {
  // consulta #3738045, quarta 07/10 13:00 BRT
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-07T16:00:00Z') / 1000), oferta), true);
});

test('consulta no mesmo dia, mais tarde, também conta', () => {
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-06T19:00:00Z') / 1000), oferta), true);
});

test('consulta de outro ciclo (antes da oferta) não esconde o alerta', () => {
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-08-20T13:00:00Z') / 1000), oferta), false);
});

test('cartão sem data, com valor quebrado ou sem campos: alerta segue', () => {
  assert.equal(cartaoTemConsulta({ custom_fields_values: [] }, oferta), false);
  assert.equal(cartaoTemConsulta({ custom_fields_values: null }, oferta), false);
  assert.equal(cartaoTemConsulta(comData(''), oferta), false);
  assert.equal(cartaoTemConsulta(comData('abc'), oferta), false);
  assert.equal(cartaoTemConsulta(null, oferta), false);
});

test('outro campo de data não é confundido com a consulta', () => {
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-07T16:00:00Z') / 1000, '◷ Retomar em'), oferta), false);
});

test('folga de fuso: rastro gravado 3 h adiantado não vira alerta', () => {
  const ofertaComFusoErrado = new Date('2026-10-06T16:14:09Z');
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-06T15:00:00Z') / 1000), ofertaComFusoErrado), true);
});
