/**
 * Item 9 da lista de 21/10/2026. Decisão do João: a regra continua "dor primeiro". O que se conserta é a falha real:
 * quando o paciente INSISTE no valor, a regra manda dar o valor na hora — e a IA desobedeceu de 11 a 29 vezes em
 * 01–20/10, respondendo com outra pergunta (nome, dor, "manhã ou tarde?").
 *
 * Rodado no corpus de 21/10 (conversas de preço/plano de 01 a 20/10): 165 turnos com insistência, 27 deles sem
 * nenhum R$ na resposta. As falas abaixo são desses casos, sem nome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { insistenciaNoPreco, perguntaPreco, renderPrecoInsistido } from './preco-insistido.js';
import { composeSystemPrompt } from './prompt-composer.js';
import type { Fala } from './repeticao.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

test('o que é pergunta de preço e o que não é', () => {
  for (const t of [
    'Qual o valor?',
    'Quanto custa a consulta ?',
    'Quanto é a consulta',
    'Moça, por favor, eu quero saber o preço da consulta pra eu possa me programar',
    'E o valor?',
    'Valor',
    'Pode me passar valores? Consulta, avaliação e procedimentos',
    'Por favor, só me diz quanto tá a consulta',
  ]) {
    assert.ok(perguntaPreco(t), `é pergunta de preço: ${t}`);
  }
  for (const t of [
    'Faz quanto tempo que dói',
    'Achei caro o valor',
    'Antecipado amanhã meu marido vai passar o valor ta bom',
    'Já paguei o valor no Pix',
    'Na lombar, há uns 3 meses',
  ]) {
    assert.ok(!perguntaPreco(t), `não é pergunta de preço: ${t}`);
  }
});

test('1ª pergunta de preço: sem insistência — vale "dor primeiro"', () => {
  assert.equal(insistenciaNoPreco([p('Bom dia\nQual valor da consulta')]), null);
  assert.equal(renderPrecoInsistido([p('Quanto custa a consulta?')], { frase: 'R$ 350 no dia' }), '');
});

test('Canaã 02/10: perguntou, a IA pediu a dor, perguntou de novo → insistiu', () => {
  const falas = [
    p('Quanto custa?'),
    ia('Já te falo tudo certo! 😊 Só me conta antes: onde dói e há quanto tempo?'),
    p('Qual o valor?'),
  ];
  assert.equal(insistenciaNoPreco(falas), 'perguntou_de_novo');
});

test('Boa Vista 19/10: "Sim / Mas qual o valor ?" depois de já ter perguntado → insistiu', () => {
  const falas = [
    p('Qual valor da consulta?'),
    ia('Perfeito, já registrei por aqui. Então, posso te mostrar os horários disponíveis?'),
    p('Sim\nMas qual o valor ?'),
  ];
  assert.equal(insistenciaNoPreco(falas), 'perguntou_de_novo');
});

test('pedido explícito já na 1ª vez: "primeiro quero saber o valor", "só me diz", "??"', () => {
  assert.equal(insistenciaNoPreco([p('Primeiro quero saber o valor da consulta')]), 'pediu_so_o_valor');
  assert.equal(insistenciaNoPreco([p('Só quero saber o preço')]), 'pediu_so_o_valor');
  assert.equal(insistenciaNoPreco([p('Bom dia!!! Gostaria de saber o valor da consulta??')]), 'pediu_so_o_valor');
  assert.equal(insistenciaNoPreco([p('Não quero falar da dor, qual o valor?')]), 'pediu_so_o_valor');
});

test('"eu perguntei o valor" sem repetir a pergunta conta, se a IA ainda não deu valor nenhum', () => {
  const base = [p('Qual o valor?'), ia('Claro! Antes me conta: onde dói?')];
  assert.equal(insistenciaNoPreco([...base, p('Eu perguntei o valor')]), 'perguntou_de_novo');
  const comValor = [p('Qual o valor?'), ia('A consulta é R$ 350 no dia, ou R$ 250 antecipado no Pix. Onde dói?')];
  assert.equal(insistenciaNoPreco([...comValor, p('responde minha pergunta, onde fica?')]), null);
});

test('o bloco do turno traz o valor escrito e manda ele vir primeiro, sem pergunta antes', () => {
  const falas = [p('Quanto custa?'), ia('Onde dói?'), p('Qual o valor?')];
  const bloco = renderPrecoInsistido(falas, { frase: 'R$ 350 no dia, ou R$ 250 pagando antes no Pix' });
  assert.match(bloco, /<preco_insistido>/);
  assert.match(bloco, /A consulta com o nosso especialista é R\$ 350 no dia, ou R\$ 250 pagando antes no Pix/);
  assert.match(bloco, /PRIMEIRA frase/);
  assert.match(bloco, /NADA antes do valor/);
  assert.doesNotMatch(bloco, /avaliação/);
  // sem os dois valores seguros nas fontes, não escreve número: manda dizer o das fontes
  assert.doesNotMatch(renderPrecoInsistido(falas, { frase: null }), /R\$/);
});

function unidade(extra: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    slug: 'teste',
    name: 'Clínica Teste',
    sourceProdutos: 'Consulta com o especialista: R$ 350 no dia ou R$ 250 antecipado no Pix. Atendimento particular.',
    personaEmojis: [],
    handoffKeywords: [],
    ...extra,
  } as unknown as Unit;
}

const INSISTIU = [p('Quanto custa?'), ia('Claro! Onde dói e há quanto tempo?'), p('Mas qual o valor?')];

test('no prompt: entra só quando insistiu, com o valor das fontes da unidade', () => {
  // (a regra de PREÇO cita o nome do bloco; o bloco de verdade abre com a linha de prioridade)
  const BLOCO = /<preco_insistido>\n\(ALTA PRIORIDADE/;
  assert.doesNotMatch(composeSystemPrompt({ unit: unidade(), historico: [p('Quanto custa?')] }), BLOCO);
  const prompt = composeSystemPrompt({ unit: unidade(), historico: INSISTIU });
  assert.match(prompt, /<preco_insistido>\n\(ALTA PRIORIDADE[\s\S]*R\$ 350 no dia, ou R\$ 250 pagando antes no Pix/);
});

test('no prompt: taxa de reserva (Boa Vista) sai como total, não como "ou"', () => {
  const unit = unidade({
    sourceProdutos: 'Consulta: R$ 100 antecipado (garante o horário) + R$ 250 no dia.',
    spineBookingRequiresPayment: true,
  } as Partial<Unit>);
  assert.match(composeSystemPrompt({ unit, historico: INSISTIU }), /R\$ 350 no total: R\$ 100 antecipado no Pix \(garante o horário\) \+ R\$ 250 no dia/);
});

test('no prompt: unidade sem preço nas fontes não recebe o bloco (não convida a inventar)', () => {
  const unit = unidade({ sourceProdutos: 'Atendimento particular.' } as Partial<Unit>);
  assert.doesNotMatch(composeSystemPrompt({ unit, historico: INSISTIU }), /<preco_insistido>\n\(ALTA PRIORIDADE/);
});

test('a regra da rede continua "dor primeiro" e ganhou a ordem dura para a 2ª pergunta', () => {
  const prompt = composeSystemPrompt({ unit: unidade() });
  assert.match(prompt, /QUANDO ELE PERGUNTAR O PREÇO E VOCÊ AINDA NÃO SOUBER DA QUEIXA/);
  assert.match(prompt, /faça UMA pergunta sobre a dor/);
  assert.match(prompt, /Na 2ª pergunta de preço o valor inteiro é a PRIMEIRA frase/);
  assert.match(prompt, /Oferecer horário no lugar do valor também é desviar/);
});
