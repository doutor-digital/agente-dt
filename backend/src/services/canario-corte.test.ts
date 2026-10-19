import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avisarCorte } from './openai.service.js';

test('canário de truncamento: avisa o corte de verdade e cala o 1 token pedido pelo cache-keepalive', () => {
  assert.equal(avisarCorte('max_tokens'), true);
  assert.equal(avisarCorte('max_tokens', false), true);
  assert.equal(avisarCorte('max_tokens', true), false);
  for (const fim of ['end_turn', 'tool_use', undefined]) assert.equal(avisarCorte(fim), false, String(fim));
});
