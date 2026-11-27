import test from 'node:test';
import assert from 'node:assert/strict';
import { ehErroDeSaldo } from './ops-alert.js';

test('ehErroDeSaldo: as duas frases reais de 26/11/2026 (Anthropic e OpenAI)', () => {
  assert.equal(
    ehErroDeSaldo(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Ch"}',
    ),
    true,
  );
  assert.equal(
    ehErroDeSaldo(
      '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/',
    ),
    true,
  );
});

test('ehErroDeSaldo: as frases antigas continuam valendo', () => {
  assert.equal(ehErroDeSaldo('You exceeded your current quota, please check your plan and billing details'), true);
  assert.equal(ehErroDeSaldo('429 insufficient_quota'), true);
  assert.equal(ehErroDeSaldo('402 Payment Required'), true);
});

test('ehErroDeSaldo: erro que NÃO é saldo não vira alarme de saldo', () => {
  assert.equal(ehErroDeSaldo('429 Rate limit reached for gpt-4o in organization on tokens per min'), false);
  assert.equal(ehErroDeSaldo('503 {"type":"error","error":{"type":"overloaded_error"}}'), false);
  assert.equal(ehErroDeSaldo('400 This API key is not scoped to a workspace'), false);
  assert.equal(ehErroDeSaldo('timeout'), false);
  assert.equal(ehErroDeSaldo(''), false);
});
