import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aplicarGuardrail } from './guardrail.js';

function unidade(fontes: { produtos?: string; papel?: string; negocio?: string }) {
  return {
    category: 'saude',
    sourceProdutos: fontes.produtos ?? null,
    sourcePapel: fontes.papel ?? null,
    sourceNegocio: fontes.negocio ?? null,
  } as never;
}

const MARABA = unidade({
  produtos: 'A CONSULTA presencial: R$ 350 pagos no mesmo dia, OU R$ 200 com pagamento antecipado.',
});
const IMPERATRIZ = unidade({ produtos: 'A CONSULTA: R$ 350 (à vista no PIX: R$ 150).' });

test('caso real de Marabá: R$ 150 do prompt chumbado era bloqueado', () => {
  const r = aplicarGuardrail('A consulta é R$ 350, ou R$ 150 à vista no PIX.', MARABA);
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.includes('150')));
});

test('com os valores DA unidade, a mesma frase passa', () => {
  const r = aplicarGuardrail('A consulta é R$ 350, ou R$ 200 com pagamento antecipado.', MARABA);
  assert.equal(r.rewritten, false);
});

test('Imperatriz segue aceitando os valores dela', () => {
  assert.equal(aplicarGuardrail('R$ 350, ou R$ 150 à vista no PIX.', IMPERATRIZ).rewritten, false);
});

test('valor inventado continua bloqueado em qualquer unidade', () => {
  assert.equal(aplicarGuardrail('A consulta sai por R$ 999.', MARABA).rewritten, true);
  assert.equal(aplicarGuardrail('A consulta sai por R$ 999.', IMPERATRIZ).rewritten, true);
});

test('parcela plausível do valor cheio NÃO é bloqueada (comportamento de propósito)', () => {
  assert.equal(aplicarGuardrail('Fica R$ 88 em 4x.', MARABA).rewritten, false);
});

test('parcelamento dos valores da unidade continua passando', () => {
  assert.equal(aplicarGuardrail('Dá pra dividir: 2x de R$ 175.', MARABA).rewritten, false);
});
