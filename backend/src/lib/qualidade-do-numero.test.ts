import { test } from 'node:test';
import assert from 'node:assert/strict';
import { melhorou, normalizarQualidade, piorou, textoDoAlerta, type LeituraDoNumero } from './qualidade-do-numero.js';

const L = (q: string, limite: string | null = null): LeituraDoNumero => ({ qualidade: normalizarQualidade(q), limite });

test('piora de cor dispara', () => {
  assert.equal(piorou(L('GREEN'), L('YELLOW')), true);
  assert.equal(piorou(L('YELLOW'), L('RED')), true);
});

test('melhora e estabilidade NÃO disparam — silêncio é o padrão', () => {
  assert.equal(piorou(L('GREEN'), L('GREEN')), false);
  assert.equal(piorou(L('YELLOW'), L('GREEN')), false);
});

test('UNKNOWN nunca vira alerta', () => {
  // a Meta devolve campo vazio de vez em quando; alerta por ruído se aprende a ignorar
  assert.equal(piorou(L('GREEN'), L('')), false);
  assert.equal(piorou(L(''), L('GREEN')), false);
});

test('primeira leitura só avisa se já nasce ruim', () => {
  assert.equal(piorou(null, L('GREEN')), false);
  assert.equal(piorou(null, L('YELLOW')), true);
});

test('teto de envio caindo dispara mesmo com a cor igual', () => {
  assert.equal(piorou(L('GREEN', 'TIER_10K'), L('GREEN', 'TIER_1K')), true);
  assert.equal(piorou(L('GREEN', 'TIER_1K'), L('GREEN', 'TIER_10K')), false);
});

test('a volta ao normal é reconhecida', () => {
  assert.equal(melhorou(L('YELLOW'), L('GREEN')), true);
  assert.equal(melhorou(L('GREEN'), L('GREEN')), false);
});

test('o alerta diz de onde pra onde e o que costuma causar', () => {
  const t = textoDoAlerta({ unidade: 'Doutor Hérnia Mossoró', numero: '+55 84 9107-4334',
    antes: L('GREEN'), agora: L('YELLOW', 'TIER_1K') });
  assert.match(t, /Mossoró/);
  assert.match(t, /GREEN → YELLOW/);
  assert.match(t, /TIER_1K/);
  assert.match(t, /denunciando/);
});

test('vermelho avisa que o próximo passo é a unidade ficar muda', () => {
  const t = textoDoAlerta({ unidade: 'X', numero: 'n', antes: L('YELLOW'), agora: L('RED') });
  assert.match(t, /MUDA/);
});
