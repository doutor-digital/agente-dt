import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corrigirRestoDoSinal, ehTotalComSinal } from './total-com-sinal.js';

test('ehTotalComSinal: o R$ que vem antes de "garantindo / com sinal" é o total', () => {
  assert.equal(ehTotalComSinal('ou ', ' garantindo com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia)'), true);
  assert.equal(ehTotalComSinal('ou ', ' garantindo com um sinal de R$ 50 antecipado no Pix'), true);
  assert.equal(ehTotalComSinal('ou ', ' com sinal de R$ 50'), true);
  assert.equal(ehTotalComSinal('ou ', ' para reservar o horário'), true);
});

test('ehTotalComSinal: o próprio sinal errado, o preço do dia e outro R$ no meio NÃO são o total', () => {
  // "sinal de R$ 80 para garantir sua vaga": o R$ 80 é o sinal
  assert.equal(ehTotalComSinal('A consulta é R$ 350 no dia, com sinal de ', ' para garantir sua vaga'), false);
  assert.equal(ehTotalComSinal('o sinal: ', ' para garantir'), false);
  // "R$ 300 no dia ou com sinal de R$ 50": o R$ 300 é o preço no dia
  assert.equal(ehTotalComSinal('A consulta é ', ' no dia ou com sinal de R$ 50'), false);
  assert.equal(ehTotalComSinal('A consulta é ', ' na clínica, ou garantindo com sinal'), false);
  assert.equal(ehTotalComSinal('', ' de sinal antecipado'), false);
  assert.equal(ehTotalComSinal('', ' no dia, ou R$ 250 garantindo com sinal'), false); // outro R$ no meio: aquele "garantindo" é do 250
  assert.equal(ehTotalComSinal('', ' no dia na clínica.'), false);
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
  // valor maior que o antecipado é o preço no dia, não o resto do sinal
  assert.equal(r('(R$ 50 agora + R$ 150 no dia). Pagando tudo fica + R$ 350 no dia').texto, '(R$ 50 agora + R$ 150 no dia). Pagando tudo fica + R$ 350 no dia');
  assert.equal(corrigirRestoDoSinal('(R$ 50 + R$ 200 no dia)', 0, 200).texto, '(R$ 50 + R$ 200 no dia)');
});
