import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSuggestions } from './reflection.service.js';

test('parseSuggestions: JSON válido vira lista de regras', () => {
  const raw = JSON.stringify({
    suggestions: [
      { rule: 'Confirme o bairro antes de oferecer horário', why: 'Vários leads em outra cidade' },
      { rule: 'Não prometa cura' },
    ],
  });
  const out = parseSuggestions(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].rule, 'Confirme o bairro antes de oferecer horário');
  assert.equal(out[0].why, 'Vários leads em outra cidade');
});

test('parseSuggestions: JSON inválido não quebra', () => {
  assert.deepEqual(parseSuggestions('não é json'), []);
  assert.deepEqual(parseSuggestions('{}'), []);
  assert.deepEqual(parseSuggestions('{"suggestions": "x"}'), []);
});

test('parseSuggestions: ignora itens sem rule e corta em 5', () => {
  const many = { suggestions: Array.from({ length: 9 }, (_, i) => ({ rule: `Regra ${i}` })) };
  many.suggestions.push({ rule: '' } as { rule: string });
  const out = parseSuggestions(JSON.stringify(many));
  assert.equal(out.length, 5);
  assert.ok(out.every((s) => s.rule.trim().length > 0));
});

test('parseSuggestions: aceita array na raiz', () => {
  const out = parseSuggestions(JSON.stringify([{ rule: 'Seja gentil' }]));
  assert.equal(out.length, 1);
});
