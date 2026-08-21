import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escolherPlanoB } from './llm-policy.js';

const base = {
  llmProvider: 'anthropic',
  anthropicApiKey: null,
  anthropicModel: null,
  openaiApiKey: null,
  openaiModel: null,
  googleApiKey: null,
  googleModel: null,
};

test('unidade de Claude cai pra OpenAI quando há chave no ambiente', () => {
  const p = escolherPlanoB({ ...base, anthropicApiKey: 'sk-ant-x' }, true);
  assert.equal(p?.provider, 'openai');
});

test('unidade de OpenAI cai pra Claude quando tem chave Anthropic', () => {
  const p = escolherPlanoB(
    { ...base, llmProvider: 'openai', anthropicApiKey: 'sk-ant-x', anthropicModel: 'claude-sonnet-5' },
    true,
  );
  assert.equal(p?.provider, 'anthropic');
  assert.equal(p?.modelName, 'claude-sonnet-5');
});

test('unidade do Gemini prefere Claude, depois OpenAI', () => {
  const comClaude = escolherPlanoB(
    { ...base, llmProvider: 'google', googleApiKey: 'g', anthropicApiKey: 'a' },
    false,
  );
  assert.equal(comClaude?.provider, 'anthropic');

  const semClaude = escolherPlanoB({ ...base, llmProvider: 'google', googleApiKey: 'g' }, true);
  assert.equal(semClaude?.provider, 'openai');
});

test('sem alternativa devolve null (aí o texto de fallback é a resposta certa)', () => {
  const p = escolherPlanoB({ ...base, anthropicApiKey: 'sk-ant-x' }, false);
  assert.equal(p, null);
});

test('nunca escolhe o MESMO provedor que acabou de falhar', () => {
  for (const provedor of ['anthropic', 'openai', 'google']) {
    const p = escolherPlanoB(
      {
        ...base,
        llmProvider: provedor,
        anthropicApiKey: 'a',
        openaiApiKey: 'o',
        googleApiKey: 'g',
      },
      true,
    );
    assert.notEqual(p?.provider, provedor, `plano B repetiu o provedor ${provedor}`);
  }
});

test('usa o modelo configurado da unidade, com padrão sensato', () => {
  const comModelo = escolherPlanoB(
    { ...base, llmProvider: 'openai', anthropicApiKey: 'a', anthropicModel: 'claude-haiku-4-5' },
    true,
  );
  assert.equal(comModelo?.modelName, 'claude-haiku-4-5');

  const semModelo = escolherPlanoB({ ...base, llmProvider: 'openai', anthropicApiKey: 'a' }, true);
  assert.ok((semModelo?.modelName ?? '').startsWith('claude-'));
});
