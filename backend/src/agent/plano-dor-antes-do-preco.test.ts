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

// ── Item 12 da lista de 21/10/2026 — decisão do João: JUNTAR ────────────────────────────────────────────
// Mantém o #94 (plano respondido na hora, sem emendar o valor, UMA pergunta sobre a dor) e, DEPOIS que o paciente
// conta a dor, a condição de quem tem plano: carteirinha (quando as fontes têm), recibo para reembolso e a oferta
// de uma ligação da equipe. Plano de saúde é lead morno: não encerra a conversa.

test('plano não encerra a conversa: lead morno, segue conduzindo', () => {
  assert.match(regraDoPlano, /paciente morno, não conversa encerrada/);
  assert.match(regraDoPlano, /NUNCA é despedida/);
});

test('o #94 continua: primeiro a pergunta do plano e UMA pergunta sobre a dor, sem valor', () => {
  const primeiroPasso = regraDoPlano.slice(0, regraDoPlano.indexOf('DEPOIS QUE ELE CONTAR A DOR'));
  assert.match(primeiroPasso, /Responda a pergunta do plano na hora/);
  assert.match(primeiroPasso, /NÃO emende o valor/);
  assert.match(primeiroPasso, /UMA pergunta/);
  assert.doesNotMatch(primeiroPasso, /reembolso|liga/);
});

test('depois da dor: valor (com carteirinha, se houver) → recibo → oferta de ligação, nessa ordem', () => {
  const depois = regraDoPlano.slice(regraDoPlano.indexOf('DEPOIS QUE ELE CONTAR A DOR'));
  assert.ok(depois.length > 0, 'o segundo passo sumiu');
  const iValor = depois.indexOf('o valor inteiro');
  const iCarteirinha = depois.indexOf('carteirinha');
  const iRecibo = depois.indexOf('o recibo para pedir reembolso');
  const iLigacao = depois.indexOf('ofereça uma ligação da equipe');
  assert.ok(iValor >= 0 && iCarteirinha > iValor && iRecibo > iCarteirinha && iLigacao > iRecibo, 'ordem: valor, carteirinha, recibo, ligação');
  assert.match(depois, /criar_tarefa/);
  assert.match(depois, /ofereça o horário da consulta/);
});

test('o que o paciente lê na regra nova fala "consulta com o nosso especialista", sem "avaliação" nem "em instantes" prometido', () => {
  assert.match(regraDoPlano, /consulta com o nosso especialista/);
  assert.doesNotMatch(regraDoPlano, /avaliaç/);
  assert.doesNotMatch(regraDoPlano, /te liga(?:mos)? em instantes/);
});
