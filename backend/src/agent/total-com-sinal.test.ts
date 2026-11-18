import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corrigirRestoDoSinal, ehTotalComSinal } from './total-com-sinal.js';

/** Balsas: R$ 350 no dia, ou R$ 200 com sinal de R$ 50 (R$ 50 + R$ 150). */
const BALSAS = { antecipado: 200, restoNoDia: 150, sinal: 50, noDia: 350 };

test('ehTotalComSinal: o R$ colado a "com (um) sinal" e mais perto do antecipado é o total', () => {
  assert.equal(ehTotalComSinal('ou ', ' garantindo com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia)', 250, BALSAS), true);
  assert.equal(ehTotalComSinal('ou ', ' garantindo com um sinal de R$ 50 antecipado no Pix', 250, BALSAS), true);
  assert.equal(ehTotalComSinal('ou ', ' com sinal de R$ 50', 230, BALSAS), true);
  assert.equal(ehTotalComSinal('ou ', ' garantindo a vaga com um sinal de R$ 50', 250, BALSAS), true);
});

test('ehTotalComSinal: "garantir / reservar" sozinhos NÃO bastam (R$ 80 pra garantir é o sinal errado, não o total)', () => {
  assert.equal(ehTotalComSinal('Pix, ', ' pra garantir sua vaga de segunda', 80, BALSAS), false);
  assert.equal(ehTotalComSinal('O sinal é de ', ' para garantir o horário', 80, BALSAS), false);
  assert.equal(ehTotalComSinal('Valor da consulta: ', ' reservando agora', 300, BALSAS), false);
  assert.equal(ehTotalComSinal('💳 ', ' de sinal para reservar o horário e os R$ 150,00 restantes', 80, BALSAS), false);
});

test('ehTotalComSinal: o próprio sinal, o preço do dia (na hora / no dia) e valor mais perto do dia NÃO são o total', () => {
  assert.equal(ehTotalComSinal('A consulta é R$ 350 no dia, com sinal de ', ' para garantir sua vaga', 80, BALSAS), false);
  assert.equal(ehTotalComSinal('o sinal: ', ' com sinal', 80, BALSAS), false);
  assert.equal(ehTotalComSinal('A consulta é ', ' no dia ou com sinal de R$ 50', 300, BALSAS), false);
  assert.equal(ehTotalComSinal('A consulta é ', ' na hora, ou garantindo com sinal de R$ 50', 380, BALSAS), false);
  assert.equal(ehTotalComSinal('A consulta é ', ' à vista, ou com sinal', 380, BALSAS), false);
  // R$ 400 está mais perto do preço do dia (350) que do antecipado (200): é o dia errado
  assert.equal(ehTotalComSinal('A consulta sai por ', ', ou você pode garantir com sinal de R$ 50 e fica R$ 200', 400, BALSAS), false);
  assert.equal(ehTotalComSinal('A consulta é ', ', ou com sinal de R$ 50 fica R$ 200 no total', 400, BALSAS), false);
  assert.equal(ehTotalComSinal('', ' no dia, ou R$ 250 garantindo com sinal', 250, BALSAS), false); // outro R$ no meio
});

test('corrigirRestoDoSinal: só o valor claramente no lugar do "resto no dia", e só se diferente da ficha', () => {
  const r = (t: string) => corrigirRestoDoSinal(t, 150, 200);
  assert.equal(r('(R$ 50 agora + R$ 200 no dia)').texto, '(R$ 50 agora + R$ 150 no dia)');
  assert.deepEqual(r('(R$ 50 agora + R$ 200 no dia)').trocas, ['200→150']);
  assert.equal(r('(e os outros R$ 200 no dia)').texto, '(e os outros R$ 150 no dia)');
  assert.equal(r('(o restante, R$ 200, no dia)').texto, '(o restante, R$ 150, no dia)');
  assert.equal(r('(e R$ 200 no dia)').texto, '(e R$ 150 no dia)');
  assert.equal(r('com sinal de R$ 50 e mais R$ 200 no dia').texto, 'com sinal de R$ 50 e mais R$ 150 no dia');
  assert.equal(r('garante com R$ 50 e faltam R$ 200 no dia').texto, 'garante com R$ 50 e faltam R$ 150 no dia');
  // já certo, ou não é o resto: não toca
  assert.equal(r('(R$ 50 agora + R$ 150 no dia)').texto, '(R$ 50 agora + R$ 150 no dia)');
  assert.equal(r('R$ 350 no dia, ou R$ 200 antecipado').texto, 'R$ 350 no dia, ou R$ 200 antecipado');
  assert.equal(r('o restante em 2x de R$ 75 no dia').texto, 'o restante em 2x de R$ 75 no dia');
  assert.equal(r('(R$ 50 agora + R$ 200 pelo tratamento)').texto, '(R$ 50 agora + R$ 200 pelo tratamento)');
  // taxa / item extra menor que o resto: não é o resto do sinal
  assert.equal(r('R$ 200 com sinal de R$ 50, e o restante de R$ 20 na clínica').texto, 'R$ 200 com sinal de R$ 50, e o restante de R$ 20 na clínica');
  assert.equal(r('(R$ 50 agora + R$ 30 de taxa na clínica)').texto, '(R$ 50 agora + R$ 30 de taxa na clínica)');
  // valor maior que o antecipado é o preço no dia, não o resto do sinal
  assert.equal(r('(R$ 50 agora + R$ 150 no dia). Pagando tudo fica + R$ 350 no dia').texto, '(R$ 50 agora + R$ 150 no dia). Pagando tudo fica + R$ 350 no dia');
  assert.equal(corrigirRestoDoSinal('(R$ 50 + R$ 200 no dia)', 0, 200).texto, '(R$ 50 + R$ 200 no dia)');
});
