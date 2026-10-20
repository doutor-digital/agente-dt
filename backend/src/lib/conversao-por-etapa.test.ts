import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ehFunilDeTratamento, eventoDeConversao } from './conversao-por-etapa.js';

/**
 * Revisão de 16/10/2026, item 4: com o status_lead chegando, o 142 (ganho) — que se repete em todo funil —
 * contava a ALTA do funil TRATAMENTO como "agendou". O funil decide.
 */

const COMERCIAL = 10;
const TRATAMENTO = 20;
const funis: Record<number, string> = { [COMERCIAL]: 'COMERCIAL', [TRATAMENTO]: 'TRATAMENTO' };
const nomeDoFunil = (id: number) => funis[id] ?? null;
const ganho = new Set([142, 555]);

test('142 no COMERCIAL é conversão; 142 no TRATAMENTO (ALTA) não é', () => {
  assert.equal(eventoDeConversao([{ id: 1, status_id: 142, pipeline_id: COMERCIAL }], ganho, nomeDoFunil)?.id, 1);
  assert.equal(eventoDeConversao([{ id: 2, status_id: 142, pipeline_id: TRATAMENTO }], ganho, nomeDoFunil), null);
});

test('lote misturado: pula a ALTA e acha a conversão de verdade', () => {
  const e = eventoDeConversao(
    [
      { id: 2, status_id: 142, pipeline_id: TRATAMENTO },
      { id: 3, status_id: 999, pipeline_id: COMERCIAL },
      { id: 4, status_id: 142, pipeline_id: COMERCIAL },
    ],
    ganho,
    nomeDoFunil,
  );
  assert.equal(e?.id, 4);
});

test('sem o esquema da conta: 142 não se afirma; etapa de id próprio vale como sempre', () => {
  assert.equal(eventoDeConversao([{ id: 5, status_id: 142, pipeline_id: COMERCIAL }], ganho, null), null);
  assert.equal(eventoDeConversao([{ id: 6, status_id: 142 }], ganho, nomeDoFunil), null, 'sem pipeline_id no evento');
  assert.equal(eventoDeConversao([{ id: 7, status_id: 555, pipeline_id: COMERCIAL }], ganho, null)?.id, 7);
});

test('etapa de id próprio no TRATAMENTO também não é conversão', () => {
  assert.equal(eventoDeConversao([{ id: 8, status_id: 555, pipeline_id: TRATAMENTO }], ganho, nomeDoFunil), null);
});

test('ehFunilDeTratamento: nome com acento/maiúscula/emoji', () => {
  assert.equal(ehFunilDeTratamento('🩺 Tratamento'), true);
  assert.equal(ehFunilDeTratamento('TRATAMENTO'), true);
  assert.equal(ehFunilDeTratamento('COMERCIAL'), false);
  assert.equal(ehFunilDeTratamento(null), false);
});
