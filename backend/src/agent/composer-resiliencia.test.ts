import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeSystemPrompt } from './prompt-composer.js';
import type { Unit } from '@prisma/client';

/**
 * O composer é o ponto mais perigoso do sistema: se ele LANÇAR, o turno morre
 * e o paciente fica sem resposta nenhuma. Cada bloco novo (aprendizados,
 * demografia, memória, auto-checagem...) é uma chance de acessar um campo nulo.
 *
 * Estes testes existem pra garantir a promessa que a arquitetura faz o tempo
 * todo: dado faltando NUNCA vira exceção, vira bloco ausente.
 */

/** Unidade com o mínimo absoluto — tudo que é opcional vem nulo. */
function unidadeCrua(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    slug: 'teste',
    name: 'Clínica Teste',
    category: null,
    systemPrompt: null,
    sourcePapel: null,
    sourceProdutos: null,
    sourceNegocio: null,
    sourceDemografia: null,
    personaCompanyName: null,
    personaTone: null,
    personaGreeting: null,
    personaResponseLength: 'normal',
    personaLanguage: 'pt-BR',
    personaEmojis: [],
    handoffKeywords: [],
    pipelineIntents: null,
    spineEnabled: false,
    qualificationEnabled: false,
    triageEnabled: false,
    collectNameEnabled: false,
    ...over,
  } as unknown as Unit;
}

test('unidade sem NADA preenchido não derruba o prompt', () => {
  const p = composeSystemPrompt({ unit: unidadeCrua() });
  assert.equal(typeof p, 'string');
  assert.ok(p.length > 0, 'o prompt não pode sair vazio');
});

test('listas ausentes (undefined) não quebram — o default assume', () => {
  const p = composeSystemPrompt({ unit: unidadeCrua() });
  assert.doesNotMatch(p, /undefined|null|\[object Object\]/, 'vazou valor cru no prompt');
});

test('nenhum bloco vaza "undefined" quando a unidade é parcial', () => {
  const p = composeSystemPrompt({
    unit: unidadeCrua({ category: 'saude', sourceProdutos: 'Consulta: R$ 350' }),
    templates: [],
    flaggedExamples: [],
    knowledge: [],
    actions: [],
    globalActions: [],
    leadFieldRules: [],
    lessons: [],
    leadMemory: null,
  });
  assert.doesNotMatch(p, /undefined/);
});

test('unidade de saúde recebe os blocos de segurança', () => {
  const p = composeSystemPrompt({ unit: unidadeCrua({ category: 'saude' }) });
  assert.match(p, /<auto_checagem>/, 'auto-checagem deve valer sempre');
  assert.match(p, /<escopo_e_knockout>/, 'knockout é só de saúde, e esta é de saúde');
});

test('unidade que NÃO é de saúde não recebe o knockout clínico', () => {
  const p = composeSystemPrompt({ unit: unidadeCrua({ category: 'energia_solar' }) });
  assert.doesNotMatch(p, /<escopo_e_knockout>/);
});

test('demografia entra como contexto e avisa pra não recitar números', () => {
  const p = composeSystemPrompt({
    unit: unidadeCrua({ sourceDemografia: 'Cidade X — 100 mil habitantes.' }),
  });
  assert.match(p, /<demografia>/);
  assert.match(p, /100 mil habitantes/);
  assert.match(p, /N[ÃA]O cite n[úu]meros demogr/i, 'precisa instruir a não citar número pro paciente');
});

test('aprendizados desligados não entram no prompt', () => {
  const lesson = (content: string, enabled: boolean) =>
    ({ id: 'x', unitId: 'u1', content, source: 'manual', enabled, createdAt: new Date(), updatedAt: new Date() }) as never;
  const p = composeSystemPrompt({
    unit: unidadeCrua(),
    lessons: [lesson('REGRA LIGADA', true), lesson('REGRA DESLIGADA', false)],
  });
  assert.match(p, /REGRA LIGADA/);
  assert.doesNotMatch(p, /REGRA DESLIGADA/);
});

test('texto gigante nas fontes não estoura o composer', () => {
  const enorme = 'x'.repeat(60_000);
  const p = composeSystemPrompt({ unit: unidadeCrua({ sourcePapel: enorme }) });
  assert.ok(p.length > 1000);
});

test('caractere estranho nas fontes não quebra a montagem', () => {
  const p = composeSystemPrompt({
    unit: unidadeCrua({ sourceNegocio: 'Aspas " e < > & \\ e emoji 🧠 e acento ção' }),
  });
  assert.match(p, /ção/);
});
