import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitIntoChunks } from './kommo.service.js';

const soma = (cs: string[]) => cs.join(' ').replace(/\s+/g, ' ').trim();
const normal = (s: string) => s.replace(/\s+/g, ' ').trim();

test('texto que cabe não é dividido', () => {
  assert.deepEqual(splitIntoChunks('Oi, tudo bem?', 100), ['Oi, tudo bem?']);
});

test('texto vazio não vira pedaço vazio', () => {
  assert.deepEqual(splitIntoChunks('', 100), []);
  assert.deepEqual(splitIntoChunks('   \n  ', 100), []);
});

test('nenhum pedaço passa do limite — é o que o canal recusa', () => {
  const t = 'Bom dia. A consulta é R$ 350 no total. Com pagamento antecipado fica R$ 200. '
    + 'O endereço é Avenida Ville Roy, 4301, no bairro Canarinho. Chegue quinze minutos antes.';
  for (const max of [40, 60, 80, 120]) {
    for (const c of splitIntoChunks(t, max)) {
      assert.ok(c.length <= max, `pedaço com ${c.length} chars estourou o limite ${max}: "${c}"`);
    }
  }
});

test('nada do texto se perde no corte', () => {
  const t = 'Primeira frase completa. Segunda frase completa. Terceira frase completa aqui.';
  assert.equal(soma(splitIntoChunks(t, 30)), normal(t));
});

test('corta em fim de frase quando dá, não no meio da palavra', () => {
  const cs = splitIntoChunks('Marquei sua consulta. Chegue cedo, por favor.', 25);
  assert.ok(cs[0].endsWith('.'), `deveria terminar em ponto: "${cs[0]}"`);
});

test('prefere a quebra de parágrafo à quebra de frase', () => {
  const cs = splitIntoChunks('Primeiro bloco aqui.\n\nSegundo bloco aqui também.', 30);
  assert.ok(!cs[0].includes('Segundo'), `juntou os dois blocos: "${cs[0]}"`);
});

test('palavra única gigante ainda é entregue, mesmo sem lugar bom pra cortar', () => {
  const cs = splitIntoChunks('a'.repeat(90), 30);
  assert.ok(cs.length >= 3);
  assert.equal(cs.join('').length, 90);
});

test('não devolve pedaço vazio no meio', () => {
  for (const c of splitIntoChunks('Uma.  Duas.   Três.    Quatro.', 12)) {
    assert.ok(c.trim().length > 0, 'pedaço vazio no meio da lista');
  }
});

test('texto no limite exato continua inteiro', () => {
  const t = 'x'.repeat(50);
  assert.deepEqual(splitIntoChunks(t, 50), [t]);
});

test('um caractere acima do limite já divide', () => {
  assert.ok(splitIntoChunks('x'.repeat(51), 50).length > 1);
});
