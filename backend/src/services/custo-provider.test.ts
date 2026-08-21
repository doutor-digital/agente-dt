import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calculateCost, providerOfModel } from './openai.service.js';

test('providerOfModel identifica pelo prefixo', () => {
  assert.equal(providerOfModel('claude-sonnet-5'), 'anthropic');
  assert.equal(providerOfModel('gemini-2.5-flash'), 'google');
  assert.equal(providerOfModel('gpt-4o-mini'), 'openai');
});

test('sonnet-5 usa o preço permanente de $2/$10', () => {
  const custo = calculateCost('claude-sonnet-5', 1_000_000, 1_000_000);
  assert.equal(custo, 12);
});

test('cache anthropic: leitura a 0.1x e escrita a 2x', () => {
  const custo = calculateCost('claude-sonnet-5', 1_000_000, 0, 500_000, 100_000);
  const esperado = (400_000 / 1e6) * 2 + (500_000 / 1e6) * 2 * 0.1 + (100_000 / 1e6) * 2 * 2;
  assert.equal(custo, Math.round(esperado * 1e6) / 1e6);
});

test('cache openai: leitura a 0.5x e escrita sem custo extra', () => {
  const custo = calculateCost('gpt-4o-mini', 1_000_000, 0, 400_000, 0);
  const esperado = (600_000 / 1e6) * 0.15 + (400_000 / 1e6) * 0.15 * 0.5;
  assert.equal(custo, Math.round(esperado * 1e6) / 1e6);
});

test('modelo desconhecido custa zero (não inventa preço)', () => {
  assert.equal(calculateCost('modelo-inexistente', 1000, 1000), 0);
});
