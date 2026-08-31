import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatarLicao, parseSuggestions } from './reflection.service.js';

test('lição com evidência fica no formato que a IA consegue imitar', () => {
  const t = formatarLicao({
    rule: 'Quando pedirem o endereço, mande o endereço.',
    frase: 'Passo aí e pago! Envia endereço',
    errado: 'ofereceu horário e ignorou o pedido',
    certo: 'mandar o endereço completo na mesma mensagem',
  });
  assert.match(t, /Passo aí e pago! Envia endereço/);
  assert.match(t, /ERRADO:/);
  assert.match(t, /CERTO:/);
});

test('sem evidência, sobra só a regra — não inventa exemplo', () => {
  const t = formatarLicao({ rule: 'Confirme o agendamento de forma clara.' });
  assert.equal(t, 'Confirme o agendamento de forma clara.');
});

test('não deixa pontuação dobrada quando a regra já termina em ponto', () => {
  const t = formatarLicao({ rule: 'Responda o valor.', errado: 'desconversou' });
  assert.ok(!/\.\./.test(t), `pontuação dobrada em: ${t}`);
});

test('parse lê os campos de evidência', () => {
  const s = parseSuggestions(JSON.stringify({
    suggestions: [{ rule: 'Mande o endereço.', frase: 'Envia endereço', errado: 'ignorou', certo: 'mandar' }],
  }));
  assert.equal(s.length, 1);
  assert.equal(s[0].frase, 'Envia endereço');
  assert.equal(s[0].certo, 'mandar');
});

test('campo de evidência vazio não vira string vazia na lição', () => {
  const s = parseSuggestions(JSON.stringify({
    suggestions: [{ rule: 'Confirme o horário.', frase: '   ', errado: '', certo: null }],
  }));
  assert.equal(s[0].frase, undefined);
  assert.equal(formatarLicao(s[0]), 'Confirme o horário.');
});

test('sugestão sem regra é descartada', () => {
  const s = parseSuggestions(JSON.stringify({ suggestions: [{ frase: 'oi' }, { rule: '  ' }] }));
  assert.equal(s.length, 0);
});

test('resposta que não é JSON não derruba a reflexão', () => {
  assert.deepEqual(parseSuggestions('desculpe, não consegui'), []);
});
