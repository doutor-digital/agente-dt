import { test } from 'node:test';
import assert from 'node:assert/strict';

function normalizarResposta(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

const repetiria = (ultima: string, nova: string) =>
  normalizarResposta(ultima) === normalizarResposta(nova);

const FALLBACK_PRECO =
  'Sobre o valor, deixa eu confirmar certinho pra não te passar informação errada 🙏 ' +
  'Me conta rapidinho: qual é o seu incômodo e onde está doendo? Aí já te oriento sobre a consulta.';

test('caso real de Marabá: 2ª vez seguida do mesmo fallback é loop', () => {
  assert.equal(repetiria(FALLBACK_PRECO, FALLBACK_PRECO), true);
});

test('espaço e caixa diferentes não escapam da detecção', () => {
  assert.equal(repetiria('  Sobre o VALOR,   deixa eu ver.  ', 'sobre o valor, deixa eu ver.'), true);
});

test('resposta diferente da anterior não é loop', () => {
  assert.equal(repetiria('Bom dia! Como posso ajudar?', FALLBACK_PRECO), false);
});

test('primeira vez (sem resposta anterior) nunca é loop', () => {
  assert.equal(repetiria('', FALLBACK_PRECO), false);
});
