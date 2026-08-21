import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aplicarGuardrail } from './guardrail.js';
import type { Unit } from '@prisma/client';

// O guardrail só olha category + os 3 campos de Fontes. Um stub mínimo basta.
function unit(over: Partial<Unit>): Unit {
  return {
    category: 'saude',
    sourceProdutos: 'A CONSULTA presencial: R$ 350 (à vista no PIX: R$ 150).',
    sourcePapel: null,
    sourceNegocio: null,
    ...over,
  } as Unit;
}

test('clínico: diagnóstico afirmativo é barrado', () => {
  const r = aplicarGuardrail('Pelo que você descreveu, você tem hérnia de disco na L5.', unit({}));
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.startsWith('clinico:diagnostico')));
});

test('clínico: prescrição de remédio é barrada', () => {
  const r = aplicarGuardrail('Enquanto isso pode tomar um anti-inflamatório pra aliviar.', unit({}));
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.startsWith('clinico:prescricao')));
});

test('clínico: promessa de "não precisa de cirurgia" é barrada', () => {
  const r = aplicarGuardrail('Fica tranquila, no seu caso não precisa de cirurgia.', unit({}));
  assert.equal(r.rewritten, true);
});

test('clínico NÃO roda fora de saúde (ex.: energia solar)', () => {
  const r = aplicarGuardrail('Você tem hérnia de disco.', unit({ category: 'energia_solar' }));
  assert.equal(r.rewritten, false);
});

test('preço fora do catálogo é barrado', () => {
  const r = aplicarGuardrail('A consulta fica R$ 200, pode ser?', unit({}));
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.startsWith('preco:')));
});

test('preço do catálogo passa', () => {
  const r = aplicarGuardrail('A avaliação é R$ 350, ou R$ 150 à vista no PIX.', unit({}));
  assert.equal(r.rewritten, false);
});

test('parcela plausível de um valor aprovado passa', () => {
  const r = aplicarGuardrail('Dá pra dividir em 3x de R$ 117.', unit({}));
  assert.equal(r.rewritten, false);
});

test('sem preço cadastrado, a trava de preço fica off (fail-open)', () => {
  const r = aplicarGuardrail('Fica R$ 999.', unit({ sourceProdutos: null, category: 'advocacia' }));
  assert.equal(r.rewritten, false);
});

test('mensagem limpa não é tocada', () => {
  const original = 'Oi! Que bom te ver por aqui 😊 Me conta, onde está doendo?';
  const r = aplicarGuardrail(original, unit({}));
  assert.equal(r.rewritten, false);
  assert.equal(r.text, original);
});
