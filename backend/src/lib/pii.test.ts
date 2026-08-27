import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mascararPii, mascararPiiProfundo } from './pii.js';

/**
 * Segredo já era mascarado no registro; dado de paciente não. A conversa
 * inteira ia pro log e pro banco com telefone, CPF e queixa clínica em texto
 * puro. Segredo vazado se troca — dado de saúde de paciente, não.
 */

test('telefone vira máscara, mas guarda o fim pra dar pra conferir', () => {
  assert.equal(mascararPii('meu telefone é 63 99188-7766'), 'meu telefone é «tel ***7766»');
  assert.equal(mascararPii('ligo no (94) 99955-8181 hoje'), 'ligo no «tel ***8181» hoje');
  assert.equal(mascararPii('+5563991021043'), '«tel ***1043»');
});

test('CPF, CNPJ, e-mail e cartão somem inteiros', () => {
  assert.equal(mascararPii('meu cpf é 123.456.789-00'), 'meu cpf é «cpf»');
  assert.equal(mascararPii('Chave PIX: 62.797.509/0001-64'), 'Chave PIX: «cnpj»');
  assert.equal(mascararPii('manda no joao@exemplo.com.br'), 'manda no «email»');
  assert.equal(mascararPii('cartão 4111 1111 1111 1111'), 'cartão «cartão»');
});

test('o CNPJ do Pix não vira telefone picado', () => {
  // O padrão de telefone morderia o meio do CNPJ se viesse antes.
  const r = mascararPii('CNPJ 57.492.822/0002-35 e tel 63 99188-7766');
  assert.match(r, /«cnpj»/);
  assert.match(r, /«tel \*\*\*7766»/);
  assert.ok(!r.includes('0002'), 'não pode sobrar pedaço do CNPJ');
});

test('a conversa continua legível depois de mascarada', () => {
  const antes =
    'Oi, sou o Luciano, dor na lombar há 20 dias. Meu telefone é 63 99188-7766 ' +
    'e meu e-mail luciano@gmail.com. Pode marcar terça às 10h?';
  const depois = mascararPii(antes);

  assert.ok(depois.includes('dor na lombar há 20 dias'), 'a queixa é o que serve pra investigar');
  assert.ok(depois.includes('Luciano'), 'o nome fica: sem ele o registro fica ilegível');
  assert.ok(depois.includes('terça às 10h'));
  assert.ok(!depois.includes('99188'), 'o telefone não pode sobrar');
  assert.ok(!depois.includes('gmail.com'));
});

test('preço e horário não são confundidos com dado pessoal', () => {
  assert.equal(mascararPii('A consulta é R$ 350, ou R$ 250 no PIX'), 'A consulta é R$ 350, ou R$ 250 no PIX');
  assert.equal(mascararPii('tenho 9h, 14h30 ou 16h'), 'tenho 9h, 14h30 ou 16h');
  assert.equal(mascararPii('consulta em 01/09/2026'), 'consulta em 01/09/2026');
});

test('mascara dentro de objeto, em qualquer profundidade', () => {
  const registro = {
    leadId: 24405762,
    messages: [{ role: 'user', content: 'meu tel é 63 99188-7766' }],
    meta: { contato: { email: 'a@b.com' } },
  };
  const m = mascararPiiProfundo(registro);

  assert.equal(m.messages[0].content, 'meu tel é «tel ***7766»');
  assert.equal(m.meta.contato.email, '«email»');
  assert.equal(m.leadId, 24405762, 'número que não é PII fica intacto');
});

test('vazio e não-texto passam sem quebrar', () => {
  assert.equal(mascararPii(''), '');
  assert.equal(mascararPiiProfundo(null), null);
  assert.equal(mascararPiiProfundo(42), 42);
});
