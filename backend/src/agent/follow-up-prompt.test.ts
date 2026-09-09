import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { composeFollowUpSystemPrompt } from './prompt-composer.js';
import { resolveModelName } from '../services/openai.service.js';

const unit = {
  id: 'u1',
  slug: 'doutor-hernia-teste',
  name: 'Doutor Hérnia Teste',
  category: 'saude',
  personaCompanyName: 'Doutor Hérnia Teste',
  personaTone: 'calorosa',
  personaResponseLength: 'curta',
  personaLanguage: 'pt-BR',
  personaEmojis: ['😊'],
  personaGreeting: null,
  llmProvider: 'anthropic',
  anthropicApiKey: 'sk-ant-teste',
  anthropicModel: 'claude-sonnet-5',
  openaiModel: 'gpt-4o',
  googleApiKey: null,
  googleModel: null,
} as unknown as Unit;

test('follow-up: prompt enxuto — persona e regras, sem ações, captura, fontes ou ferramentas', () => {
  const p = composeFollowUpSystemPrompt(unit);
  assert.ok(p.includes('<persona>'), 'tem persona');
  assert.ok(p.includes('<regras_gerais>'), 'tem regras gerais');
  assert.ok(p.includes('ANTI-ALUCINAÇÃO'), 'mantém a regra de não inventar preço/horário');
  for (const bloco of ['<acoes>', '<captura_dados>', '<fontes>', '<comportamentos_ativados>', '<respostas_prontas>', '<calendario>']) {
    assert.ok(!p.includes(bloco), `não carrega ${bloco}`);
  }
  assert.ok(p.length < 8000, `prompt do follow-up ficou grande: ${p.length} caracteres`);
});

test('follow-up: registra o modelo que realmente respondeu, não o nome do openai', () => {
  assert.equal(resolveModelName(unit), 'claude-sonnet-5');
  assert.equal(resolveModelName({ ...unit, llmProvider: 'openai' } as unknown as Unit), 'gpt-4o');
  assert.equal(resolveModelName(unit, 'gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(
    resolveModelName({ ...unit, llmProvider: 'google', googleApiKey: 'g', googleModel: null } as unknown as Unit),
    'gemini-2.5-flash',
  );
});
