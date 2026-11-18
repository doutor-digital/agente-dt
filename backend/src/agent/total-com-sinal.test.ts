import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corrigirRestoDoSinal, ehTotalComSinal } from './total-com-sinal.js';

test('ehTotalComSinal: o R$ que vem antes de "garantindo / com sinal" é o total; "R$ 80 de sinal" é o próprio sinal', () => {
  assert.equal(ehTotalComSinal(' garantindo com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia)'), true);
  assert.equal(ehTotalComSinal(' garantindo com um sinal de R$ 50 antecipado no Pix'), true);
  assert.equal(ehTotalComSinal(' com sinal de R$ 50'), true);
  assert.equal(ehTotalComSinal(' para reservar o horário'), true);
  assert.equal(ehTotalComSinal(' de sinal antecipado'), false); // o R$ é o sinal
  assert.equal(ehTotalComSinal(' no dia, ou R$ 250 garantindo com sinal'), false); // outro R$ no meio: aquele "garantindo" é do 250
  assert.equal(ehTotalComSinal(' no dia na clínica.'), false);
});

test('corrigirRestoDoSinal: só o valor claramente no lugar do "resto no dia", e só se diferente da ficha', () => {
  const r = (t: string) => corrigirRestoDoSinal(t, 150);
  assert.equal(r('(R$ 50 agora + R$ 200 no dia)').texto, '(R$ 50 agora + R$ 150 no dia)');
  assert.deepEqual(r('(R$ 50 agora + R$ 200 no dia)').trocas, ['200→150']);
  assert.equal(r('(e os outros R$ 200 no dia)').texto, '(e os outros R$ 150 no dia)');
  assert.equal(r('(o restante, R$ 200, no dia)').texto, '(o restante, R$ 150, no dia)');
  assert.equal(r('(e R$ 200 no dia)').texto, '(e R$ 150 no dia)');
  // já certo, ou não é o resto: não toca
  assert.equal(r('(R$ 50 agora + R$ 150 no dia)').texto, '(R$ 50 agora + R$ 150 no dia)');
  assert.equal(r('R$ 350 no dia, ou R$ 200 antecipado').texto, 'R$ 350 no dia, ou R$ 200 antecipado');
  assert.equal(r('o restante em 2x de R$ 75 no dia').texto, 'o restante em 2x de R$ 75 no dia');
  assert.equal(r('(R$ 50 agora + R$ 200 pelo tratamento)').texto, '(R$ 50 agora + R$ 200 pelo tratamento)');
  assert.equal(corrigirRestoDoSinal('(R$ 50 + R$ 200 no dia)', 0).texto, '(R$ 50 + R$ 200 no dia)');
});
