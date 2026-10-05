/**
 * Teste gravado na Açailândia, 05/10/2026 (lead 10824318): a Sofia de RESGATE (sem agenda) inventou
 * "quinta 08/10 às 8h30, fica reservado pro seu nome" sem marcar nada; quando o cartão passou para a
 * Sofia COMERCIAL, ela perguntou "como posso te chamar?" a quem tinha acabado de dar o nome.
 *
 * O que estes testes prendem:
 *  - Sofia sem agenda recebe a regra "nunca ofereça horário nem diga reservado", acima das ações da unidade;
 *    quem tem agenda não recebe (não muda o prompt das outras);
 *  - a conversa com a outra Sofia entra no prompt, avisando para não se reapresentar e que "reservado"
 *    dito pela outra NÃO é consulta marcada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Unit } from '@prisma/client';

import { renderConversaComOutraSofia, renderSemAgenda } from './conversa-entre-sofias.js';
import { composeSystemPrompt, composeSystemPromptParts } from './prompt-composer.js';

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-resgate', slug: 'acailandia-resgate', name: 'Doutor Hérnia Açailândia', category: 'saude',
    systemPrompt: null, personaResponseLength: 'normal', personaLanguage: 'pt-BR', personaEmojis: [], handoffKeywords: [],
    pipelineIntents: null, spineEnabled: false, spineAgendaDays: [1, 2, 3, 4, 5],
    businessHoursTimezone: 'America/Sao_Paulo', spineTimezone: 'America/Sao_Paulo', sourceProdutos: null,
    ...over,
  } as unknown as Unit;
}

const CONVERSA = [
  { papel: 'paciente' as const, texto: 'Teste Doutor Digital', em: new Date('2026-10-05T18:23:05Z') },
  { papel: 'sofia' as const, texto: 'Prazer, Teste! Essa dor na lombar já tá incomodando há quanto tempo?', em: new Date('2026-10-05T18:23:34Z') },
  { papel: 'paciente' as const, texto: 'Dói há 6 meses', em: new Date('2026-10-05T18:24:43Z') },
];

test('sem agenda: a regra só existe para quem não tem agenda', () => {
  assert.match(renderSemAgenda({ spineEnabled: false }), /NUNCA ofereça dia nem horário/);
  assert.match(renderSemAgenda({ spineEnabled: false }), /NUNCA diga que reservou/);
  assert.equal(renderSemAgenda({ spineEnabled: true }), '');
});

test('sem agenda: entra no prompt da Sofia de resgate e não no de quem tem agenda', () => {
  assert.match(composeSystemPrompt({ unit: unidade() }), /Você NÃO tem acesso à agenda/);
  assert.doesNotMatch(composeSystemPrompt({ unit: unidade({ spineEnabled: true }) }), /Você NÃO tem acesso à agenda/);
  // na montagem com cache, fica na parte fixa (não custa a cada mensagem)
  const partes = composeSystemPromptParts({ unit: unidade() });
  assert.match(partes.cacheable, /Você NÃO tem acesso à agenda/);
});

test('outra Sofia: o bloco traz a conversa e manda não se reapresentar nem confiar em "reservado"', () => {
  const b = renderConversaComOutraSofia(CONVERSA)!;
  assert.match(b, /<conversa_com_outra_sofia>/);
  assert.match(b, /NÃO se apresente de novo/);
  assert.match(b, /isso NÃO foi marcado/);
  assert.match(b, /Paciente: Teste Doutor Digital/);
  assert.match(b, /Sofia: Prazer, Teste!/);
  assert.equal(renderConversaComOutraSofia([]), null);
});

test('outra Sofia: entra na parte variável do prompt da Sofia comercial', () => {
  const partes = composeSystemPromptParts({ unit: unidade({ spineEnabled: true, slug: 'doutor-hernia-acailandia' }), leadId: 10824318, outraSofia: CONVERSA });
  assert.match(partes.dynamic, /Paciente: Dói há 6 meses/);
  assert.doesNotMatch(partes.cacheable, /conversa_com_outra_sofia/);
});
