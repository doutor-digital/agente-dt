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

test('texto real da Serra (dois conjuntos, particular primeiro): pega 250/350, nunca o 220 do plano', () => {
  const serra =
    'A CONSULTA tem DOIS conjuntos de valores. PARTICULAR (padrão): R$ 350 no dia da avaliação, ou R$ 250 com pagamento antecipado por PIX. ' +
    'COM PLANO DE SAÚDE (só quando o paciente disser que tem plano): R$ 250 no dia, ou R$ 220 com pagamento antecipado. O valor de R$ 220 NÃO existe para paciente particular.';
  assert.deepEqual(precosDaConsulta({ sourceProdutos: serra, systemPrompt: '' }), { antecipado: 250, noDia: 350 });
});

test('"no ato da consulta" também conta como valor no dia', () => {
  assert.deepEqual(
    precosDaConsulta({ sourceProdutos: 'R$ 350,00 no ato da consulta, R$ 250,00 antecipado.', systemPrompt: '' }),
    { antecipado: 250, noDia: 350 },
  );
});
