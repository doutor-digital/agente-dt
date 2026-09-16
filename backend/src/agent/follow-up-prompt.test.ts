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

const COM_PIX = {
  ...unit,
  pixKey: '68.896.219/0001-54',
  pixHolder: 'Sousa e Magalhaes Clinica de Fisioterapia LTDA',
  sourceProdutos: 'A CONSULTA: R$ 250 antecipado (pago antes da consulta) ou R$ 350 no dia.',
  systemPrompt: '',
} as unknown as Unit;

test('follow-up: a chave Pix e os valores ESTÃO no prompt — o degrau de 5 min pede os dois', () => {
  // sem isto o modelo recebia "envie a chave Pix da unidade" sem a chave em
  // lugar nenhum do contexto, e mandava "[chave das Fontes Oficiais]"
  const p = composeFollowUpSystemPrompt(COM_PIX);
  assert.ok(p.includes('68.896.219/0001-54'), 'tem a chave');
  assert.ok(p.includes('Sousa e Magalhaes'), 'tem o titular');
  assert.ok(p.includes('R$ 250'), 'tem o antecipado');
  assert.ok(p.includes('R$ 350'), 'tem o valor no dia');
  assert.ok(!p.includes('<fontes>'), 'segue sem as fontes inteiras — o bloco é enxuto');
});

test('follow-up: unidade sem Pix cadastrado não ganha bloco vazio', () => {
  const p = composeFollowUpSystemPrompt(unit);
  assert.ok(!p.includes('<dados_da_clinica>'), 'sem dado, sem bloco');
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
