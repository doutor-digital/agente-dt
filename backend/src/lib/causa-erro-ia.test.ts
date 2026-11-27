import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classificarCausa } from './causa-erro-ia.js';

test('«Connection error.» do SDK é indisponibilidade (rede), não «outra»', () => {
  assert.equal(classificarCausa('Connection error.'), 'indisponivel');
  assert.equal(classificarCausa('APIConnectionError: Connection error.'), 'indisponivel');
});

test('as três mensagens reais da noite de 26/11 e as vizinhas', () => {
  assert.equal(classificarCausa('400 invalid_request_error: Your credit balance is too low to access the Anthropic API'), 'credito');
  assert.equal(classificarCausa('429 You have no credits remaining'), 'credito');
  assert.equal(classificarCausa('401 Incorrect API key provided'), 'autenticacao');
  assert.equal(classificarCausa('Error code: 429 - slow down'), 'limite');
  assert.equal(classificarCausa('messages: text too long (512 tokens max)'), 'outra');
});
