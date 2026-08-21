import { test } from 'node:test';
import assert from 'node:assert/strict';

import { confiancaDaMedia, compararVersoes } from './eval-confidence.js';

test('sem conversas avaliadas, a média não vale nada', () => {
  const c = confiancaDaMedia(0);
  assert.equal(c.nivel, 'insuficiente');
  assert.match(c.explicacao, /sem conversas avaliadas/i);
});

test('poucas conversas = insuficiente; dezenas = indicativo; muitas = confiável', () => {
  assert.equal(confiancaDaMedia(5).nivel, 'insuficiente');
  assert.equal(confiancaDaMedia(11).nivel, 'insuficiente');
  assert.equal(confiancaDaMedia(12).nivel, 'indicativo');
  assert.equal(confiancaDaMedia(39).nivel, 'indicativo');
  assert.equal(confiancaDaMedia(40).nivel, 'confiavel');
  assert.equal(confiancaDaMedia(250).nivel, 'confiavel');
});

test('a margem de erro encolhe conforme a amostra cresce', () => {
  const poucas = confiancaDaMedia(12).margemErro;
  const muitas = confiancaDaMedia(200).margemErro;
  assert.ok(muitas < poucas, 'mais conversas deveriam dar margem menor');
  assert.ok(muitas < 0.3, `com 200 conversas a margem deveria ser pequena, veio ${muitas}`);
});

test('não compara quando uma das versões tem amostra pequena', () => {
  const r = compararVersoes({ rotulo: 'A', media: 9.5, n: 3 }, { rotulo: 'B', media: 6.0, n: 80 });
  assert.equal(r.conclusivo, false);
  assert.equal(r.vencedora, null);
  assert.match(r.explicacao, /menos de 12/i);
});

test('diferença pequena entre versões é tratada como empate (é ruído)', () => {
  const r = compararVersoes({ rotulo: 'A', media: 7.9, n: 30 }, { rotulo: 'B', media: 7.7, n: 30 });
  assert.equal(r.conclusivo, false);
  assert.equal(r.vencedora, null);
  assert.match(r.explicacao, /empatadas/i);
});

test('diferença grande com amostra boa aponta a vencedora', () => {
  const r = compararVersoes({ rotulo: 'nova', media: 8.6, n: 120 }, { rotulo: 'antiga', media: 6.9, n: 120 });
  assert.equal(r.conclusivo, true);
  assert.equal(r.vencedora, 'nova');
  assert.ok(r.diferenca > 1);
});

test('a ordem dos argumentos não muda quem vence', () => {
  const a = { rotulo: 'X', media: 8.6, n: 120 };
  const b = { rotulo: 'Y', media: 6.9, n: 120 };
  assert.equal(compararVersoes(a, b).vencedora, compararVersoes(b, a).vencedora);
});

test('entrada inválida não quebra', () => {
  assert.equal(confiancaDaMedia(-5).nivel, 'insuficiente');
  assert.equal(confiancaDaMedia(Number.NaN).nivel, 'insuficiente');
});
