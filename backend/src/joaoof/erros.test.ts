import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classificarErroDeConta, ehErroDeConta, textoDoErroDeConta } from './erros.js';

const SALDO = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
const LIMITE = '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."}}';

test('as frases REAIS de saldo e de limite de uso (ambas vêm como 400!) são erro de CONTA, não de conteúdo', () => {
  assert.equal(classificarErroDeConta(SALDO), 'saldo');
  assert.equal(classificarErroDeConta(LIMITE), 'limite');
  assert.equal(ehErroDeConta(SALDO), true);
});

test('chave: 401, 403, x-api-key inválida e chave ausente', () => {
  for (const e of ['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', '403 permission_error: forbidden', 'JOAOOF_ANTHROPIC_API_KEY ausente: o Joaoof não usa a chave de nenhuma clínica']) {
    assert.equal(classificarErroDeConta(e), 'chave', e);
  }
});

test('erro de conteúdo, indisponibilidade e vazio NÃO são erro de conta', () => {
  for (const e of ['400 invalid_request_error: messages.0.content: text content blocks must be non-empty', '529 overloaded_error', '429 rate_limit_error: too many requests', 'timeout', '', undefined]) {
    assert.equal(ehErroDeConta(e as string), false, String(e));
  }
});

test('o aviso é português claro, diz o que fazer, e nunca carrega JSON cru', () => {
  for (const e of [SALDO, LIMITE, '401 invalid x-api-key', 'JOAOOF_ANTHROPIC_API_KEY ausente']) {
    const t = textoDoErroDeConta(e);
    assert.match(t, /^Joaoof parado:/);
    assert.match(t, /console\.anthropic\.com|ligar-joaoof/);
    assert.doesNotMatch(t, /[{}"]|invalid_request/);
  }
  assert.match(textoDoErroDeConta(SALDO), /SEM CRÉDITO/);
  assert.match(textoDoErroDeConta(LIMITE), /LIMITE/);
  assert.match(textoDoErroDeConta('401 x'), /INVÁLIDA/);
});

test('número 401/403 solto no meio do texto NÃO vira «chave inválida» (erro de conteúdo ou de rede que só cita o número)', () => {
  assert.equal(ehErroDeConta('400 invalid_request_error: messages.401.content must be non-empty'), false);
  assert.equal(ehErroDeConta('request timed out after 403ms'), false);
  assert.equal(ehErroDeConta('Error: 401'), false); // sem o contexto de status HTTP no começo
  assert.equal(ehErroDeConta('401 Unauthorized'), true);
});

test('modelo inexistente (404 not_found_error) e 422 são erro de CONFIGURAÇÃO, com texto próprio', () => {
  const e = '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonet-5"}}';
  assert.equal(classificarErroDeConta(e), 'modelo');
  assert.match(textoDoErroDeConta(e), /MODELO configurado.*JOAOOF_MODELO_BARATO/);
  assert.equal(ehErroDeConta('422 unprocessable_entity'), true);
  assert.equal(ehErroDeConta('400 invalid_request_error: messages.404.content'), false);
});
