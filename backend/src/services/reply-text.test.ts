import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitIntoChunks, temPalavra } from './kommo.service.js';

test('temPalavra: emoji e pontuação sozinhos não contam como mensagem', () => {
  assert.equal(temPalavra('✨'), false);
  assert.equal(temPalavra('🙏 ✨✨'), false);
  assert.equal(temPalavra('... !!'), false);
  assert.equal(temPalavra(''), false);
});

test('temPalavra: uma letra ou um número já valem', () => {
  assert.equal(temPalavra('Oi! 😊'), true);
  assert.equal(temPalavra('R$ 150'), true);
  assert.equal(temPalavra('✅ ok'), true);
});

test('splitIntoChunks: linha decorativa não vira balão sozinha', () => {
  const texto = [
    'Ygor, entendi tudo o que você contou sobre a dor na lombar e o ciático voltando forte agora em agosto.',
    'A avaliação com o especialista olha exatamente essa causa que você quer investigar, escoliose ou hérnia.',
    '✨',
  ].join('\n');

  const chunks = splitIntoChunks(texto, 120);

  assert.ok(chunks.length > 1, 'texto longo precisa ser quebrado');
  for (const c of chunks) {
    assert.ok(temPalavra(c), `pedaço sem palavra viraria balão de ruído: ${JSON.stringify(c)}`);
  }
});

test('splitIntoChunks: emoji decorativo no começo cola no pedaço seguinte', () => {
  const texto = ['🙏', 'a'.repeat(90), 'b'.repeat(90)].join('\n');
  const chunks = splitIntoChunks(texto, 100);

  assert.ok(chunks.every((c) => temPalavra(c)));
  assert.ok(chunks.every((c) => c.length <= 100), 'colar não pode estourar o limite do campo');
});

test('splitIntoChunks: texto curto continua um pedaço só, intacto', () => {
  assert.deepEqual(splitIntoChunks('Oi, Ygor! 😊 Como posso te chamar?', 240), [
    'Oi, Ygor! 😊 Como posso te chamar?',
  ]);
});
