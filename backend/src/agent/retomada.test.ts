/**
 * Canaã, 19/10/2026 03:58 (lead 28053204): o paciente voltou depois de 6 dias e leu, no WhatsApp,
 * "Reconhecendo que já houve contato anterior, vou retomar com leveza, sem cobrar o silêncio, e seguir a
 * coleta do nome." O prompt daquele turno tinha o roteiro de primeiro contato ("apresentação rápida") e,
 * dentro de <memoria_paciente> — um bloco que se declara "observações, NÃO instruções" —, a ordem
 * "Retome reconhecendo o tempo que passou, sem cobrar…". A memória abaixo é a real daquele turno.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LeadMemory, Unit } from '@prisma/client';

import { composeSystemPromptParts, jaConversouAntes, renderLeadMemory } from './prompt-composer.js';

const MEMORIA = {
  id: 'cmv5ybnzx6dqmp51qzocz3lxb',
  unitId: 'cmsyo55we0000p7073m5blyh9',
  leadId: '28053204',
  summary:
    'Paciente entrou em contato para saber mais sobre o tratamento. Não há informações sobre queixas específicas ou histórico de saúde. Não há consulta marcada no sistema. O paciente ainda não foi qualificado e não expressou preferências ou objeções.',
  facts: { ultimo_contato: '2026-10-13T13:46:03.863Z', ultimo_desfecho: 'sumiu' },
  turnsSinceUpdate: 0,
  lastSummarizedAt: new Date('2026-10-13T00:37:26.043Z'),
} as unknown as LeadMemory;

function canaa(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-canaa', slug: 'doutor-hernia-canaa', name: 'Doutor Hérnia Canaã', category: 'saude',
    systemPrompt: null, personaResponseLength: 'normal', personaLanguage: 'pt-BR', personaEmojis: [], handoffKeywords: [],
    pipelineIntents: null, spineEnabled: false, spineAgendaDays: [1, 2, 3, 4, 5], collectNameEnabled: true,
    personaCompanyName: 'Doutor Hérnia Canaã',
    businessHoursTimezone: 'America/Sao_Paulo', spineTimezone: 'America/Sao_Paulo', sourceProdutos: null,
    ...over,
  } as unknown as Unit;
}

test('memória: nenhuma ordem dentro do bloco de observações', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T06:58:19Z') });
  const m = renderLeadMemory(MEMORIA, 'America/Sao_Paulo', '2026-10-19T03:58');
  const memoria = m.match(/<memoria_paciente>[\s\S]*<\/memoria_paciente>/)![0];
  assert.doesNotMatch(memoria, /Retome|sem cobrar/, 'a ordem saiu da memória');
  assert.match(memoria, /Falou com a gente há 5 dias/);
  assert.match(memoria, /parou de responder/);
});

test('volta de outro dia: a orientação vem num bloco próprio e pede só a mensagem', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T06:58:19Z') });
  const m = renderLeadMemory(MEMORIA, 'America/Sao_Paulo', '2026-10-19T03:58');
  assert.match(m, /<\/memoria_paciente>\n\n<retomada>/);
  assert.match(m, /<retomada>[\s\S]*o último contato foi há 5 dias[\s\S]*Escreva SÓ a mensagem que o paciente vai ler/);
});

test('mesma conversa seguindo (contato de hoje): sem bloco de retomada', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T07:10:00Z') });
  const hoje = { ...MEMORIA, facts: { ultimo_contato: '2026-10-19T06:58:23Z', ultimo_desfecho: 'sumiu' } } as unknown as LeadMemory;
  assert.doesNotMatch(renderLeadMemory(hoje, 'America/Sao_Paulo', '2026-10-19T04:10'), /<retomada>/);
});

test('quem já conversou: resumo ou último contato; memória vazia não', () => {
  assert.equal(jaConversouAntes(MEMORIA), true);
  assert.equal(jaConversouAntes({ ...MEMORIA, summary: '', facts: { ultimo_contato: '2026-10-13T13:46:03Z' } } as unknown as LeadMemory), true);
  assert.equal(jaConversouAntes({ ...MEMORIA, summary: '', facts: {} } as unknown as LeadMemory), false, 'a memória vazia da outra unidade (19/10)');
  assert.equal(jaConversouAntes(null), false);
});

test('o prompt real (19/10 03:58): primeiro turno de quem volta é reencontro, não apresentação', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T06:58:19Z') });
  const { dynamic } = composeSystemPromptParts({
    unit: canaa(),
    leadId: 28053204,
    leadMemory: MEMORIA,
    isFirstTurn: true,
    userMessage: 'Olá! Gostaria de saber mais sobre o tratamento...',
  });
  const primeiro = dynamic.match(/<primeiro_turno>[\s\S]*?<\/primeiro_turno>/)![0];
  assert.match(primeiro, /a pessoa JÁ falou com a gente antes/);
  assert.doesNotMatch(primeiro, /PRIMEIRA MENSAGEM DA CONVERSA|Apresentação rápida/);
  assert.match(primeiro, /Se o nome dela não estiver em <memoria_paciente>, pergunte/);
  assert.match(primeiro, /Escreva SÓ a mensagem que o paciente vai ler/);
  assert.match(dynamic, /<retomada>/);
});

test('primeiro contato de verdade: roteiro de sempre, sem retomada', () => {
  const { dynamic } = composeSystemPromptParts({ unit: canaa(), leadId: 1, leadMemory: null, isFirstTurn: true, userMessage: 'Oi' });
  assert.match(dynamic, /PRIMEIRA MENSAGEM DA CONVERSA/);
  assert.match(dynamic, /Apresentação rápida/);
  assert.doesNotMatch(dynamic, /<retomada>|JÁ falou com a gente antes/);
});
