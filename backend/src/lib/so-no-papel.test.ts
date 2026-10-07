/**
 * Placar da aba "Só no papel": conta decisões por tipo e cartões distintos (um cartão pode ter várias
 * linhas — um campo por linha nos robôs de campo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resumirSimulacoes } from './so-no-papel.js';

test('resumo: conta por ação e cartões distintos; ação desconhecida só conta o cartão', () => {
  const r = resumirSimulacoes([
    { acao: 'moveria', kommoLeadId: 1 },
    { acao: 'gravaria', kommoLeadId: 2 },
    { acao: 'confere', kommoLeadId: 2 },
    { acao: 'diverge', kommoLeadId: 3 },
    { acao: 'outra', kommoLeadId: 4 },
  ]);
  assert.deepEqual(r, { moveria: 1, gravaria: 1, confere: 1, diverge: 1, etiquetaria: 0, pularia: 0, cartoes: 4 });
});

test('resumo: lista vazia é tudo zero', () => {
  assert.deepEqual(resumirSimulacoes([]), { moveria: 0, gravaria: 0, confere: 0, diverge: 0, etiquetaria: 0, pularia: 0, cartoes: 0 });
});
