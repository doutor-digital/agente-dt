import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAnthropicEffort } from './openai.service.js';

test('valores validos passam normalizados', () => {
  assert.equal(resolveAnthropicEffort('low'), 'low');
  assert.equal(resolveAnthropicEffort('MEDIUM'), 'medium');
  assert.equal(resolveAnthropicEffort(' high '), 'high');
});

test('vazio, nulo ou lixo viram null (API usa o padrao dela)', () => {
  assert.equal(resolveAnthropicEffort(null), null);
  assert.equal(resolveAnthropicEffort(undefined), null);
  assert.equal(resolveAnthropicEffort(''), null);
  assert.equal(resolveAnthropicEffort('xhigh'), null);
  assert.equal(resolveAnthropicEffort('turbo'), null);
});
