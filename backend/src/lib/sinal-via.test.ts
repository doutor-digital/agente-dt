/** Por onde o sinal é cobrado (lib/sinal-via.ts): o padrão é o Asaas, em toda unidade, até o João ligar a variável. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinalViaDaUnidade } from './sinal-via.js';

const ACA = 'doutor-hernia-acailandia';

test('sem variável, vazia ou com valor desconhecido: asaas (nada muda em nenhuma unidade)', () => {
  assert.equal(sinalViaDaUnidade(ACA, {}), 'asaas');
  assert.equal(sinalViaDaUnidade(ACA, { SOFIA_SINAL_VIA_ACAILANDIA: '' }), 'asaas');
  assert.equal(sinalViaDaUnidade(ACA, { SOFIA_SINAL_VIA_ACAILANDIA: '   ' }), 'asaas');
  assert.equal(sinalViaDaUnidade(ACA, { SOFIA_SINAL_VIA_ACAILANDIA: 'pix' }), 'asaas');
  assert.equal(sinalViaDaUnidade(ACA, { SOFIA_SINAL_VIA_ACAILANDIA: 'infinitepay!' }), 'asaas');
});

test('infinitepay só na unidade da variável: o slug inteiro ou o final dele, sem diferenciar maiúsculas', () => {
  assert.equal(sinalViaDaUnidade(ACA, { SOFIA_SINAL_VIA_ACAILANDIA: 'infinitepay' }), 'infinitepay');
  assert.equal(sinalViaDaUnidade(ACA, { SOFIA_SINAL_VIA_DOUTOR_HERNIA_ACAILANDIA: ' InfinitePay ' }), 'infinitepay');
  assert.equal(sinalViaDaUnidade('doutor-hernia-araguaina', { SOFIA_SINAL_VIA_ACAILANDIA: 'infinitepay' }), 'asaas', 'outra unidade não herda');
  assert.equal(sinalViaDaUnidade('araguaina-resgate', { SOFIA_SINAL_VIA_ACAILANDIA: 'infinitepay' }), 'asaas');
});

test('a variável mais específica (slug inteiro) vence a curta, e "asaas" explícito desliga', () => {
  assert.equal(sinalViaDaUnidade(ACA, { SOFIA_SINAL_VIA_DOUTOR_HERNIA_ACAILANDIA: 'asaas', SOFIA_SINAL_VIA_ACAILANDIA: 'infinitepay' }), 'asaas');
});
