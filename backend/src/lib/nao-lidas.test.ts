/**
 * O aviso das não lidas — e as regras que fazem dele um aviso, não ruído.
 *
 * O risco desta funcionalidade não é errar a conta: é virar uma mensagem diária que a
 * pessoa para de abrir. Todo teste aqui defende isso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { espera, horasDesde, montarAviso, type NaoLidasDaConta } from './nao-lidas.js';

const conta = (unidade: string, naoLidas: number, maisAntigaHoras: number | null): NaoLidasDaConta => ({
  unidade,
  naoLidas,
  maisAntigaHoras,
});

test('sem pendência nenhuma, não há aviso — e não é aviso vazio, é nada', () => {
  assert.equal(montarAviso([conta('a', 0, null), conta('b', 0, null)]), null);
  assert.equal(montarAviso([]), null);
});

test('unidade zerada não aparece no texto', () => {
  const t = montarAviso([conta('serra', 5, 3), conta('maraba', 0, null)]) ?? '';
  assert.ok(t.includes('serra'));
  assert.ok(!t.includes('maraba'), 'quem está em dia não ocupa linha');
});

test('ordena pela espera mais longa, não pela quantidade', () => {
  const t = montarAviso([conta('muitas', 90, 2), conta('antiga', 3, 50)]) ?? '';
  assert.ok(
    t.indexOf('antiga') < t.indexOf('muitas'),
    'o que decide a ordem do dia é há quanto tempo alguém espera',
  );
});

test('o sinal acompanha a espera', () => {
  const t = montarAviso([conta('vermelha', 1, 30), conta('amarela', 1, 6), conta('branca', 1, 1)]) ?? '';
  assert.ok(/🔴 vermelha/.test(t));
  assert.ok(/🟡 amarela/.test(t));
  assert.ok(/⚪ branca/.test(t));
});

test('o total soma só quem tem pendência', () => {
  const t = montarAviso([conta('a', 7, 2), conta('b', 0, null), conta('c', 5, 1)]) ?? '';
  assert.ok(t.includes('12 pessoas'), 'esperava 7 + 5, sem contar a zerada');
});

test('conta que falhou aparece como falha, nunca como zero', () => {
  const t = montarAviso([{ unidade: 'quebrada', naoLidas: 0, maisAntigaHoras: null, erro: '401' }]) ?? '';
  assert.ok(t.includes('Não consegui conferir'), 'silêncio por erro é pior que o erro');
  assert.ok(t.includes('quebrada'));
});

test('horasDesde não devolve negativo quando o relógio do Kommo está à frente', () => {
  const futuro = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(horasDesde(futuro), 0);
  assert.equal(horasDesde(undefined), null);
});

test('a espera é escrita pra ser lida com pressa', () => {
  assert.equal(espera(0), 'menos de 1h');
  assert.equal(espera(5), '5h');
  assert.equal(espera(47), '47h');
  assert.equal(espera(48), '2 dias');
  assert.equal(espera(null), '?');
});
