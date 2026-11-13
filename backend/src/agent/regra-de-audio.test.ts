import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { composeFollowUpSystemPrompt, composeSystemPrompt } from './prompt-composer.js';

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
} as unknown as Unit;

test('Caxias 13/11: o prompt principal proíbe falar da transcrição e do paciente em 3ª pessoa; o follow-up (sem áudio) não paga esse custo', () => {
  const p = composeSystemPrompt({ unit });
  assert.match(p, /<audio>[\s\S]*Nunca fale de "transcrição"[\s\S]*<\/audio>/);
  assert.doesNotMatch(composeFollowUpSystemPrompt(unit), /<audio>/);
});
