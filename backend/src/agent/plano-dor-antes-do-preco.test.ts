/**
 * "Atende pelo plano?" não é "quanto custa?" (João, 20/10/2026).
 *
 * Em Araguaína a paciente perguntou "Atende pelo plano unimed?" e a Sofia respondeu, na mesma mensagem, que é
 * particular E os dois valores da consulta. A regra antiga mandava literalmente "volte ao valor com PIX". Pedido do
 * João: "pra não falar o valor de cara, mas entender a dor do lead! Quando for plano".
 *
 * O que estes testes prendem no prompt da rede:
 *  - a pergunta do plano é respondida na hora (enrolar perde confiança);
 *  - o valor NÃO vem emendado: primeiro uma pergunta sobre a dor;
 *  - o reembolso só depois do valor;
 *  - a ordem antiga ("volte ao valor com PIX") não volta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';

function unidade(): Unit {
  return {
    id: 'u1',
    slug: 'teste',
    name: 'Clínica Teste',
    category: null,
    systemPrompt: null,
    sourcePapel: null,
    sourceProdutos: 'Consulta com o especialista: R$ 350 no dia ou R$ 250 antecipado no Pix. Atendimento particular, sem convênio.',
    sourceNegocio: null,
    sourceDemografia: null,
    personaCompanyName: null,
    personaTone: null,
    personaGreeting: null,
    personaResponseLength: 'normal',
    personaLanguage: 'pt-BR',
    personaEmojis: [],
    handoffKeywords: [],
    pipelineIntents: null,
    spineEnabled: false,
    qualificationEnabled: false,
    triageEnabled: false,
    collectNameEnabled: false,
  } as unknown as Unit;
}

const prompt = composeSystemPrompt({ unit: unidade() });
const regraDoPlano = prompt.slice(prompt.indexOf('"ATENDE PELO PLANO?"'), prompt.indexOf('DEPOIS DE CONTORNAR'));

test('a regra do plano está no prompt de quem tem preço cadastrado', () => {
  assert.ok(prompt.includes('"ATENDE PELO PLANO?"'), 'a regra do plano sumiu do prompt');
  assert.ok(regraDoPlano.length > 0);
});

test('responde o plano na hora, mas não emenda o valor: primeiro a dor', () => {
  assert.match(regraDoPlano, /Responda a pergunta do plano na hora/);
  assert.match(regraDoPlano, /NÃO emende o valor/);
  assert.match(regraDoPlano, /onde dói/);
});

test('reembolso só depois do valor', () => {
  assert.match(regraDoPlano, /reembolso[\s\S]*DEPOIS do valor/);
});

test('a ordem antiga de voltar ao valor com PIX não volta', () => {
  assert.doesNotMatch(prompt, /volte ao valor com PIX/);
});
