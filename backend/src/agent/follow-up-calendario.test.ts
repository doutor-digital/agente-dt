import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeFollowUpSystemPrompt } from './prompt-composer.js';
import type { Unit } from '@prisma/client';

/**
 * O follow-up precisa saber que dia é hoje.
 *
 * Serra, 24/09/2026: a paciente Cátia pediu "me procure depois do dia 05 de outubro" e o
 * follow-up respondeu, no MESMO dia, "passando o dia 05/10 aqui está" e logo depois
 * "o dia 05/10 já passou!". A conversa normal nunca erra isso porque recebe o bloco
 * <calendario>; o follow-up era montado sem ele e o modelo chutava a data.
 */
const UNIDADE = {
  slug: 'doutor-hernia-serra',
  name: 'Doutor Hérnia Serra',
  category: 'saude',
  systemPrompt: 'Você é a Sofia.',
  sourceProdutos: null,
  sourceNegocio: null,
  sourcePapel: null,
  clinicAddress: null,
  spineTimezone: 'America/Sao_Paulo',
} as unknown as Unit;

test('o prompt do follow-up traz a data de hoje', () => {
  const p = composeFollowUpSystemPrompt(UNIDADE, new Date('2026-09-24T18:00:00Z'));
  assert.match(p, /HOJE é .*24\/09\/2026/, 'a data de hoje não aparece no prompt do follow-up');
});

test('traz só a linha da data, não o bloco <calendario> inteiro', () => {
  // O prompt do follow-up é enxuto por causa do custo por mensagem: o mês e os feriados
  // não servem aqui, só o dia.
  const p = composeFollowUpSystemPrompt(UNIDADE, new Date('2026-09-24T18:00:00Z'));
  assert.doesNotMatch(p, /<calendario>/, 'o bloco <calendario> inteiro voltou para o follow-up');
  assert.ok(p.length < 8000, `prompt do follow-up ficou grande: ${p.length} caracteres`);
});

test('diz de que lado a data cai — foi isso que a Sofia errou', () => {
  const p = composeFollowUpSystemPrompt(UNIDADE, new Date('2026-09-24T18:00:00Z'));
  assert.match(p, /AINDA NÃO chegou/, 'falta dizer que data posterior a hoje não passou');
});

test('a data acompanha o dia, não fica congelada', () => {
  const hoje = composeFollowUpSystemPrompt(UNIDADE, new Date('2026-09-24T18:00:00Z'));
  const amanha = composeFollowUpSystemPrompt(UNIDADE, new Date('2026-09-25T18:00:00Z'));
  assert.notEqual(hoje, amanha, 'o calendário do follow-up não mudou de um dia para o outro');
});

test('continua trazendo a persona e os fatos da unidade', () => {
  const p = composeFollowUpSystemPrompt(UNIDADE, new Date('2026-09-24T18:00:00Z'));
  assert.match(p, /Sofia/, 'a persona sumiu do prompt do follow-up');
});
