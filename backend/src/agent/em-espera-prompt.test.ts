import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';

/**
 * A etapa EM ESPERA separa "depois" de "não".
 *
 * Medido na Imperatriz em 03/09/2026: 2.000 cartões em PERDIDO e o motivo
 * "Solicitado exames" escolhido uma vez. Quem ia buscar um exame caía no mesmo
 * balde de quem recusou, e a janela do WhatsApp fechava antes de alguém voltar.
 *
 * A etapa só funciona com data — sem `◷ Retomar em` vira estacionamento. Por
 * isso o prompt precisa mandar salvar os dois campos ANTES de mover, e precisa
 * dizer o que NÃO é espera: um "não" educado tem que continuar indo para PERDIDO.
 */

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    slug: 'doutor-hernia-imperatriz',
    name: 'Doutor Hérnia Imperatriz',
    category: 'saude',
    systemPrompt: null,
    personaResponseLength: 'normal',
    personaLanguage: 'pt-BR',
    personaEmojis: [],
    handoffKeywords: [],
    pipelineIntents: null,
    spineEnabled: false,
    ...over,
  } as unknown as Unit;
}

test('com waiting_deferred, o prompt ensina a etapa EM ESPERA com o id da conta', () => {
  const p = composeSystemPrompt({ unit: unidade({ pipelineIntents: { waiting_deferred: 111237788 } }) });
  assert.match(p, /EM ESPERA \(statusId 111237788\)/);
  assert.match(p, /mover_etapa\(\{ statusId: 111237788 \}\)/);
});

test('a ordem é rígida: salvar Retomar em e Motivo da espera ANTES de mover', () => {
  const p = composeSystemPrompt({ unit: unidade({ pipelineIntents: { waiting_deferred: 111237788 } }) });
  assert.match(p, /ANTES de mover/);
  assert.match(p, /◷ Retomar em/);
  assert.match(p, /⊘ Motivo da espera/);
});

test('as datas padrão por motivo estão no prompt (o paciente raramente diz a data)', () => {
  const p = composeSystemPrompt({ unit: unidade({ pipelineIntents: { waiting_deferred: 111237788 } }) });
  assert.match(p, /Exames \+10 dias/);
  assert.match(p, /Viajando \+7/);
  assert.match(p, /Vai decidir \+3/);
  assert.match(p, /Financeiro agora não \+30/);
});

test('um "não" continua NÃO sendo espera', () => {
  const p = composeSystemPrompt({ unit: unidade({ pipelineIntents: { waiting_deferred: 111237788 } }) });
  assert.match(p, /"não quero"[\s\S]{0,80}NÃO é espera/);
});

test('sem waiting_deferred, nada de EM ESPERA entra no prompt', () => {
  const p = composeSystemPrompt({ unit: unidade({ pipelineIntents: { scheduled_meeting: 108773008 } }) });
  assert.doesNotMatch(p, /EM ESPERA \(statusId/);
  assert.doesNotMatch(p, /Retomar em/);
});

test('sem intenção nenhuma, o bloco inteiro fica de fora', () => {
  const p = composeSystemPrompt({ unit: unidade({ pipelineIntents: null }) });
  assert.doesNotMatch(p, /<pipeline_intents>/);
});
