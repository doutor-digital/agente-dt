import { test } from 'node:test';
import assert from 'node:assert/strict';

import { precosDaConsulta } from './prompt-composer.js';

/**
 * A linha de valor da confirmação vinha chumbada no código ("R$ 150 no PIX à vista
 * (ou R$ 350)"). Agora sai das fontes da unidade — e quando não dá para achar os
 * dois valores com segurança, a linha vira instrução, nunca número inventado.
 */
test('acha antecipado e no dia na frase padrão da casa', () => {
  assert.deepEqual(
    precosDaConsulta({ sourceProdutos: 'Consulta: R$ 200 antecipado (pago antes da consulta) ou R$ 350 no dia.', systemPrompt: '' }),
    { antecipado: 200, noDia: 350 },
  );
});

test('aceita valor próprio da unidade (Serra 220/350)', () => {
  assert.deepEqual(
    precosDaConsulta({ sourceProdutos: '', systemPrompt: 'Avaliação R$ 220 antecipado via PIX; R$ 350 no dia.' }),
    { antecipado: 220, noDia: 350 },
  );
});

test('frase herdada com "à vista" e sem "antecipado" não gera número — cai na instrução', () => {
  assert.equal(precosDaConsulta({ sourceProdutos: 'R$ 350 (à vista no PIX: R$ 250)', systemPrompt: '' }), null);
});

test('sem fontes, nulo; antecipado maior que no dia é descartado', () => {
  assert.equal(precosDaConsulta({ sourceProdutos: null, systemPrompt: '' }), null);
  assert.equal(precosDaConsulta({ sourceProdutos: 'R$ 400 antecipado ou R$ 350 no dia', systemPrompt: '' }), null);
});
