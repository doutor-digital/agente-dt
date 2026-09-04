import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';

/**
 * 02/09/2026, Serra: a Sofia confirmou "segunda-feira, 08/09" (08/09/2026 é terça —
 * era segunda em 2025, o ano do treino do modelo) e "R$ 220 no PIX à vista" (frase
 * chumbada no código, número trocado). O prompt agora carrega um calendário
 * calculado por código e a linha de valor sai das fontes da unidade.
 */
function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-serra',
    slug: 'doutor-hernia-serra',
    name: 'Doutor Hérnia Serra',
    category: 'saude',
    systemPrompt: null,
    personaResponseLength: 'normal',
    personaLanguage: 'pt-BR',
    personaEmojis: [],
    handoffKeywords: [],
    pipelineIntents: null,
    spineEnabled: true,
    spineAgendaDays: [1, 2, 3, 4, 5],
    businessHoursTimezone: 'America/Sao_Paulo',
    spineTimezone: 'America/Sao_Paulo',
    sourceProdutos: 'Avaliação: R$ 220 antecipado (pago antes da consulta) ou R$ 350 no dia.',
    clinicAddress: 'Rua Cecília Meireles, 55 — Serra/ES',
    pixKey: '45.589.929/0001-36',
    ...over,
  } as unknown as Unit;
}

test('o prompt carrega o calendário com o dia da semana calculado e o feriado marcado', () => {
  const p = composeSystemPrompt({ unit: unidade() });
  assert.match(p, /<calendario>/);
  assert.match(p, /Hoje é (segunda|terça|quarta|quinta|sexta)-feira|Hoje é (sábado|domingo)/);
  assert.match(p, /use EXATAMENTE estes nomes/);
});

test('a confirmação manda copiar o dia da semana da ferramenta e usa o preço da unidade, nunca "à vista"', () => {
  const p = composeSystemPrompt({ unit: unidade() });
  assert.match(p, /Data: \{dia da semana e data EXATAMENTE como a ferramenta agendar_consulta devolveu/);
  assert.match(p, /✨ Valor: R\$ 220 antecipado \(pago antes da consulta\) ou R\$ 350 no dia/);
  assert.doesNotMatch(p, /R\$ 150 no PIX à vista/);
});

test('sem os dois valores nas fontes, a linha de valor vira instrução — não número inventado', () => {
  const p = composeSystemPrompt({ unit: unidade({ sourceProdutos: 'Consulta com o especialista. Valores sob consulta.' }) });
  assert.match(p, /✨ Valor: \{os valores DESTA unidade/);
  assert.doesNotMatch(p, /R\$ 150/);
});
