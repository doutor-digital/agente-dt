import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withTimeout, LlmTimeoutError, FALLBACK_INDISPONIVEL } from './llm-policy.js';

test('withTimeout: resolve quando a promessa responde a tempo', async () => {
  const r = await withTimeout(Promise.resolve('ok'), 50);
  assert.equal(r, 'ok');
});

test('withTimeout: rejeita com LlmTimeoutError quando estoura', async () => {
  const lenta = new Promise((res) => setTimeout(() => res('tarde'), 60));
  await assert.rejects(withTimeout(lenta, 20), (e) => e instanceof LlmTimeoutError);
});

test('withTimeout: propaga o erro original da promessa (não mascara)', async () => {
  const falha = Promise.reject(new Error('boom'));
  await assert.rejects(withTimeout(falha, 100), /boom/);
});

test('fallback é uma frase de verdade (tem palavras)', () => {
  assert.ok(/[a-zA-ZÀ-ÿ]{3,}/.test(FALLBACK_INDISPONIVEL));
});
