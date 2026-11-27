import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerArgs } from './retomar-apos-queda.js';

const AGORA = new Date('2026-11-27T13:00:00Z');

test('padrão = SIMULAÇÃO: sem --aplicar nada age; janela de 26/11 21h UTC até agora', () => {
  const a = lerArgs([], AGORA);
  assert.equal(a.aplicar, false);
  assert.equal(a.desde.toISOString(), '2026-11-26T21:00:00.000Z');
  assert.equal(a.ate.toISOString(), AGORA.toISOString());
  assert.deepEqual(a.unidades, []);
  assert.equal(a.paralelo, 3);
  assert.equal(a.ignorarSaude, false);
});

test('--aplicar liga a ação; --desde/--ate/--unidade/--paralelo (com espaço ou =) são lidos', () => {
  const a = lerArgs(['--aplicar', '--desde', '2026-11-27T00:00:00Z', '--ate=2026-11-27T12:11:00Z', '--unidade', 'doutor-hernia-taubate, hm-tecnologia', '--paralelo=5'], AGORA);
  assert.equal(a.aplicar, true);
  assert.equal(a.desde.toISOString(), '2026-11-27T00:00:00.000Z');
  assert.equal(a.ate.toISOString(), '2026-11-27T12:11:00.000Z');
  assert.deepEqual(a.unidades, ['doutor-hernia-taubate', 'hm-tecnologia']);
  assert.equal(a.paralelo, 5);
});

test('data inválida e paralelo fora de 1..8 recusam (não rodam com palpite)', () => {
  assert.throws(() => lerArgs(['--desde', 'ontem'], AGORA), /data inválida/);
  assert.throws(() => lerArgs(['--paralelo', '0'], AGORA), /paralelo/);
  assert.throws(() => lerArgs(['--paralelo', '50'], AGORA), /paralelo/);
});
