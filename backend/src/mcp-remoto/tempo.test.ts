import assert from 'node:assert/strict';
import { test } from 'node:test';
import { epochDoDiaLocal, hojeNoFuso } from './tempo.js';

test('00:00 de São Paulo é 03:00 UTC; 23:59:59 é 02:59:59 do dia seguinte', () => {
  assert.equal(new Date(epochDoDiaLocal('2026-09-01', 'America/Sao_Paulo') * 1000).toISOString(), '2026-09-01T03:00:00.000Z');
  assert.equal(new Date(epochDoDiaLocal('2026-09-30', 'America/Sao_Paulo', true) * 1000).toISOString(), '2026-10-01T02:59:59.000Z');
});

test('outro fuso (Manaus, -4)', () => {
  assert.equal(new Date(epochDoDiaLocal('2026-09-01', 'America/Manaus') * 1000).toISOString(), '2026-09-01T04:00:00.000Z');
});

test('hoje no fuso: 01:00 UTC ainda é ontem em São Paulo', () => {
  assert.equal(hojeNoFuso('America/Sao_Paulo', new Date('2026-10-07T01:00:00Z')), '2026-10-06');
});
