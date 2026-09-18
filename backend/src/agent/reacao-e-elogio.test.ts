import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { previewComposedPrompt } from './prompt-composer.js';

const unit = {
  id: 'u1', slug: 'teste', name: 'Teste', category: 'saude',
  personaCompanyName: 'Clínica Teste', personaTone: 'calorosa',
  personaResponseLength: 'curta', personaLanguage: 'pt-BR',
  personaEmojis: ['😊'], llmProvider: 'anthropic', anthropicApiKey: 'x',
  spineAgendaDays: [1, 2, 3, 4, 5],
} as unknown as Unit;

test('o bloco entra no prompt de qualquer unidade', () => {
  const p = previewComposedPrompt(unit);
  assert.ok(p.includes('<reacao_e_elogio>'), 'bloco presente');
});

test('dor em uma linha é tratada como LEAD, não como reação', () => {
  // "escreveram tudo o que eu sinto 😢" quase virou descarte (Mossoró, 18/09)
  const p = previewComposedPrompt(unit);
  assert.match(p, /ISSO É LEAD/);
  assert.match(p, /NUNCA trate como reação sem valor/);
});

test('elogio de paciente vira pedido de avaliação no Google', () => {
  const p = previewComposedPrompt(unit);
  assert.match(p, /avaliação no Google/i);
  assert.match(p, /sem insistir/);
  // sem link inventado: a unidade pode não ter
  assert.match(p, /sem link se você\s+não tiver o link/);
});

test('reação sem conteúdo NÃO recebe oferta', () => {
  const p = previewComposedPrompt(unit);
  assert.match(p, /NÃO ofereça consulta/);
  assert.match(p, /quem\s+só reagiu a um story não pediu nada/);
});

test('a regra separa primeiro contato de emoji no meio da conversa', () => {
  // a persona manda "retomar o proximo passo" em emoji; aqui o oposto. Sem dizer
  // qual vale quando, o modelo escolhe a errada.
  const p = previewComposedPrompt(unit);
  assert.match(p, /PRIMEIRO contato de alguém que nunca falou/);
  assert.match(p, /A diferença é se já havia\s+conversa antes/);
});

test('a exceção à pergunta obrigatória é explícita', () => {
  // a regra global manda toda resposta terminar com pergunta; aqui é o oposto,
  // e sem dizer isso em voz alta o modelo obedece a regra mais antiga
  const p = previewComposedPrompt(unit);
  assert.match(p, /ÚNICA situação em que sua resposta NÃO termina com pergunta/);
});
