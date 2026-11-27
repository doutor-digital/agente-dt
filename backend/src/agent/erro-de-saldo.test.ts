import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatOpenAI } from '@langchain/openai';
import { ehErroDeSaldoOuCota, semSufixoDoLangchain } from './erro-de-saldo.js';
import { ehErroDeSaldo } from '../lib/ops-alert.js';

function erroHttp(status: number, msg: string): Error {
  return Object.assign(new Error(msg), { status });
}

test('as duas frases reais de 26/11/2026 são saldo', () => {
  assert.equal(
    ehErroDeSaldoOuCota(
      erroHttp(400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing"}}'),
    ),
    true,
  );
  assert.equal(
    ehErroDeSaldoOuCota(erroHttp(429, '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com')),
    true,
  );
});

test('OpenAI insufficient_quota e "exceeded your current quota" são saldo', () => {
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, '429 You exceeded your current quota, please check your plan and billing details. insufficient_quota')), true);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, '429 You exceeded your current quota, please check your plan and billing details.')), true);
});

const GEMINI_POR_MINUTO =
  '[GoogleGenerativeAI Error]: [429 Too Many Requests] You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, model: gemini-2.5-flash Please retry in 12.5s. [{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12s"}] RESOURCE_EXHAUSTED';
const GEMINI_POR_DIA =
  '[GoogleGenerativeAI Error]: [429 Too Many Requests] You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 1500 [{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}] RESOURCE_EXHAUSTED';

test('Gemini: limite POR MINUTO (passa em segundos) NÃO é saldo — não pode abrir circuito por 2 min', () => {
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, GEMINI_POR_MINUTO)), false);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, '429 RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota). retry in 3s')), false);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, '429 RESOURCE_EXHAUSTED')), false);
});

test('Gemini: cota por DIA e crédito pré-pago esgotado SÃO saldo', () => {
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, GEMINI_POR_DIA)), true);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, 'RESOURCE_EXHAUSTED: Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.')), true);
});

test('OpenAI: 429 de rate limit por minuto/tokens NÃO é saldo, mesmo falando em "quota"/"billing"', () => {
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, '429 Rate limit reached for gpt-4o-mini in organization org-x on tokens per min (TPM): Limit 200000, Used 199000. Please try again in 6ms. Visit billing to increase your quota')), false);
});

test('Anthropic "reached your specified API usage limits" é saldo', () => {
  assert.equal(
    ehErroDeSaldoOuCota(erroHttp(400, 'You have reached your specified API usage limits. You will regain access on 2026-12-01')),
    true,
  );
});

test('402 é saldo mesmo sem texto', () => {
  assert.equal(ehErroDeSaldoOuCota(erroHttp(402, 'Payment Required')), true);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(402, '')), true);
});

test('o status pode vir só no começo da mensagem (SDK da Anthropic)', () => {
  assert.equal(ehErroDeSaldoOuCota(new Error('402 {"error":"x"}')), true);
});

test('429 de limite por minuto NÃO é saldo (passageiro, não abre circuito)', () => {
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, '429 Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000')), false);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit of 50 requests per minute"}}')), false);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(429, 'Too Many Requests')), false);
});

test('timeout, 5xx, conexão e erro do paciente NÃO são saldo', () => {
  const timeout = new Error('IA não respondeu em 35000ms');
  timeout.name = 'LlmTimeoutError';
  assert.equal(ehErroDeSaldoOuCota(timeout), false);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(503, '503 Service Unavailable overloaded')), false);
  assert.equal(ehErroDeSaldoOuCota(new Error('ECONNRESET')), false);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(401, '401 invalid x-api-key')), false);
  assert.equal(ehErroDeSaldoOuCota(erroHttp(400, 'messages.3: tool_use ids were found without tool_result blocks')), false);
});

test('null, undefined e string solta não quebram', () => {
  assert.equal(ehErroDeSaldoOuCota(null), false);
  assert.equal(ehErroDeSaldoOuCota(undefined), false);
  assert.equal(ehErroDeSaldoOuCota('429 You have no credits remaining'), true);
});

test('o ehErroDeSaldo do alerta continua respondendo igual para o que já cobria', () => {
  assert.equal(ehErroDeSaldo('Your credit balance is too low'), true);
  assert.equal(ehErroDeSaldo('insufficient_quota'), true);
  assert.equal(ehErroDeSaldo('429 Rate limit reached'), false);
});

// O erro COMO O LANGCHAIN ENTREGA (ChatOpenAI de verdade, só o fetch é falso): classe própria, code/type e o sufixo
// "Troubleshooting URL: …/MODEL_RATE_LIMIT/" colado a todo 429 — inclusive ao de saldo.
async function erroDoChatOpenAI(body: unknown, status = 429): Promise<Error> {
  const modelo = new ChatOpenAI({
    apiKey: 'sk-teste',
    model: 'gpt-4o-mini',
    maxRetries: 0,
    configuration: {
      fetch: (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as never,
    },
  });
  try {
    await modelo.invoke('oi');
  } catch (e) {
    return e as Error;
  }
  throw new Error('o ChatOpenAI não falhou');
}

test('OpenAI sem saldo, embrulhado pelo LangChain (InsufficientQuotaError + sufixo MODEL_RATE_LIMIT), É saldo', async () => {
  for (const message of [
    'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
    'You have no credits remaining. Add credits to continue using the API',
  ]) {
    const err = await erroDoChatOpenAI({ error: { message, type: 'insufficient_quota', param: null, code: 'insufficient_quota' } });
    assert.match(err.message, /MODEL_RATE_LIMIT/, 'pré-condição: o sufixo do LangChain está na mensagem');
    assert.equal(err.name, 'InsufficientQuotaError');
    assert.equal(ehErroDeSaldoOuCota(err), true, message);
  }
});

test('OpenAI sem saldo é saldo pelo code/name mesmo com a mensagem irreconhecível', () => {
  assert.equal(ehErroDeSaldoOuCota(Object.assign(new Error('429 algo estranho\n\nTroubleshooting URL: https://x/MODEL_RATE_LIMIT/'), { code: 'insufficient_quota' })), true);
  assert.equal(ehErroDeSaldoOuCota(Object.assign(new Error('x'), { name: 'InsufficientQuotaError' })), true);
});

test('OpenAI rate limit por minuto, embrulhado pelo LangChain, NÃO é saldo', async () => {
  const err = await erroDoChatOpenAI({ error: { message: 'Rate limit reached for gpt-4o-mini on tokens per min (TPM): Limit 200000', type: 'tokens', code: 'rate_limit_exceeded' } });
  assert.equal(err.name, 'RateLimitCapacityError');
  assert.equal(ehErroDeSaldoOuCota(err), false);
});

test('semSufixoDoLangchain tira só o sufixo do fim', () => {
  assert.equal(semSufixoDoLangchain('429 x\n\nTroubleshooting URL: https://docs.langchain.com/a/MODEL_RATE_LIMIT/\n'), '429 x');
  assert.equal(semSufixoDoLangchain('429 sem sufixo'), '429 sem sufixo');
});
