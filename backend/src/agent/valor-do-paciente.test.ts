import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posicoesDeValorDoPaciente } from './valor-do-paciente.js';

/** Os trechos que a função aponta como "do paciente", na ordem em que aparecem (cada um começa no "R$"). */
function doPaciente(texto: string): string[] {
  return [...posicoesDeValorDoPaciente(texto)].sort((a, b) => a - b).map((i) => /^R\$\s*[\d.]+(?:,\d{2})?/i.exec(texto.slice(i))![0]);
}

test('valor do paciente: o que o comprovante / o paciente pagou, mandou ou fez', () => {
  assert.deepEqual(doPaciente('Esse comprovante é de R$ 900,00 — valor diferente do nosso pagamento antecipado da consulta (R$ 250).'), ['R$ 900,00']);
  assert.deepEqual(doPaciente('O comprovante mostra R$ 50,00, mas o valor antecipado da nossa consulta é R$ 200,00.'), ['R$ 50,00']);
  assert.deepEqual(doPaciente('Recebi seu comprovante, mas o valor mostrado foi de R$ 50,00 — e o valor antecipado é de R$ 250.'), ['R$ 50,00']);
  assert.deepEqual(doPaciente('Reparei que o valor foi de R$ 750,00 — aqui a consulta antecipada é R$ 200,00.'), ['R$ 750,00']);
  assert.deepEqual(doPaciente('Você pagou R$ 50 de Pix, mas a consulta antecipada é R$ 200.'), ['R$ 50']);
  assert.deepEqual(doPaciente('O Pix de R$ 50 que você pagou não cobre o antecipado de R$ 200.'), ['R$ 50']);
  assert.deepEqual(doPaciente('O comprovante é da unidade certa, mas o valor de R$ 200 ficou abaixo do antecipado, que é R$ 250.'), ['R$ 200']);
  assert.deepEqual(doPaciente('O comprovante é da nossa clínica, mas o valor de R$ 50 não bate com o antecipado (que é R$ 200).'), ['R$ 50']);
  assert.deepEqual(doPaciente('O comprovante tem R$ 100,00 e o valor ficou abaixo do antecipado de R$ 250,00.'), ['R$ 100,00']);
  assert.deepEqual(doPaciente('O comprovante mostra R$ 50 e o antecipado é R$ 200.'), ['R$ 50']);
  assert.deepEqual(doPaciente('Esse valor de R$ 50 ainda não bate com o antecipado, que é R$ 200.'), ['R$ 50']);
  assert.deepEqual(doPaciente('O valor que caiu foi R$ 200, e o nosso Pix antecipado é de R$ 250.'), ['R$ 200']);
});

test('valor do paciente: preço da unidade, pedido e sinal NÃO entram', () => {
  assert.deepEqual(doPaciente('A consulta é R$ 350 no dia, ou R$ 250 com pagamento antecipado.'), []);
  assert.deepEqual(doPaciente('R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia)'), []);
  // pedido: o R$ aqui é o preço que ELA quer receber
  assert.deepEqual(doPaciente('Pode me enviar o comprovante certinho, com o valor de R$ 200,00?'), []);
  assert.deepEqual(doPaciente('Preciso do comprovante, o antecipado é R$ 200.'), []);
  // a palavra "comprovante" sozinha não basta: sem verbo de relato colado ao valor, o R$ é preço e segue conferido
  assert.deepEqual(doPaciente('Falta só o comprovante do Pix de R$ 250 pra gente confirmar.'), []);
  assert.deepEqual(doPaciente('Com o comprovante em mãos, o valor completo é R$ 250.'), []);
  assert.deepEqual(doPaciente('Se você pagou o sinal de R$ 80, me manda o comprovante.'), []);
  assert.deepEqual(doPaciente('Se você fez o Pix de R$ 80, me manda o comprovante.'), []);
  assert.deepEqual(doPaciente('O valor da campanha foi de R$ 150 em outubro.'), []);
  assert.deepEqual(doPaciente('A consulta é R$ 250 — então não bate com o outro valor.'), []);
  // verbo de relato longe do valor, ou falando de preço: é o preço
  assert.deepEqual(doPaciente('Sobre o comprovante: o valor é R$ 300 no Pix.'), []);
  assert.deepEqual(doPaciente('Com o comprovante o valor é R$ 300.'), []);
  assert.deepEqual(doPaciente('O valor mostrado no site é R$ 250.'), []);
  // o preço colado depois do valor: não é o que o paciente mandou (mas "…e o antecipado é" é outra oração e não conta)
  assert.deepEqual(doPaciente('O valor que consta aqui é R$ 250 antecipado.'), []);
  assert.deepEqual(doPaciente('O valor foi de R$ 300 a consulta antecipada.'), []);
  assert.deepEqual(doPaciente('Se você já pagou os R$ 250 antecipados, é só me mandar o comprovante.'), []);
  assert.deepEqual(doPaciente('Fico no aguardo do comprovante de R$ 250 pra confirmar.'), []);
  assert.deepEqual(doPaciente('Se você já mandou o Pix, fica R$ 300 no dia.'), []);
  assert.deepEqual(doPaciente('Você enviou o Pix, ficam R$ 250 no dia.'), []);
  assert.deepEqual(doPaciente('Me manda o comprovante de R$ 200 pra eu confirmar.'), []);
  // "comprovante" na frase de antes não vale para a frase de depois
  assert.deepEqual(doPaciente('Recebi o comprovante, obrigada! A consulta antecipada é R$ 250.'), []);
  // o comprovante tem outra frase de preço no meio: o R$ é o preço
  assert.deepEqual(doPaciente('Recebi o comprovante 😊 A consulta com sinal é R$ 200.'), []);
  assert.deepEqual(doPaciente(''), []);
  assert.deepEqual(doPaciente('Sem valores aqui.'), []);
});

test('valor do paciente: cada R$ é julgado sozinho (o comprovante vale só até o próximo R$)', () => {
  const t = 'O comprovante mostra R$ 50,00, mas o antecipado é R$ 200,00 e o dia é R$ 350,00.';
  assert.deepEqual(doPaciente(t), ['R$ 50,00']);
});
