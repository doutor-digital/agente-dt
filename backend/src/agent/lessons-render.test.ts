import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderLessons } from './prompt-composer.js';
import type { UnitLesson } from '@prisma/client';

function lesson(over: Partial<UnitLesson>): UnitLesson {
  return {
    id: 'x', unitId: 'u', content: 'Regra', source: 'manual', enabled: true,
    createdAt: new Date(0), updatedAt: new Date(0), ...over,
  } as UnitLesson;
}

test('sem lições ativas, não injeta bloco', () => {
  assert.equal(renderLessons([]), '');
  assert.equal(renderLessons([lesson({ enabled: false, content: 'off' })]), '');
});

test('lições ativas viram bloco <aprendizados> com bullets', () => {
  const out = renderLessons([
    lesson({ content: 'Sempre confirme o bairro antes de oferecer horário' }),
    lesson({ content: 'Nunca prometa resultado' }),
  ]);
  assert.match(out, /<aprendizados>/);
  assert.match(out, /- Sempre confirme o bairro/);
  assert.match(out, /- Nunca prometa resultado/);
});

test('lição desativada não aparece; ativa aparece', () => {
  const out = renderLessons([
    lesson({ content: 'ATIVA aqui', enabled: true }),
    lesson({ content: 'DESATIVADA aqui', enabled: false }),
  ]);
  assert.match(out, /ATIVA aqui/);
  assert.doesNotMatch(out, /DESATIVADA aqui/);
});
