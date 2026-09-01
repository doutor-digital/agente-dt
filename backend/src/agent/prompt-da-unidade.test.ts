import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { Unit } from '@prisma/client';

import { escolherBase } from './prompt-composer.js';

/**
 * Qual texto vira as instruções da IA.
 *
 * Existe por causa de um achado de 31/08/2026: o manual escrito em cada unidade
 * — 18 a 21 mil caracteres, com a regra do comprovante de Boa Vista dentro —
 * nunca chegava ao modelo, porque o prompt genérico do AgentConfig ganhava
 * sempre. Ninguém viu por meses: a IA continuava respondendo bem, só que sem o
 * manual.
 *
 * A troca é por unidade, e o padrão é NÃO mudar nada. Um interruptor que muda
 * o comportamento de 26 clínicas sozinho não é interruptor, é acidente.
 */

const GENERICO = 'Você é um agente de qualificação de leads do CRM Kommo. Responda em UMA frase.';
const MANUAL = 'Paciente escolheu: NÃO agende ainda. Peça o comprovante do PIX antes de reservar.';

function unidade(over: Partial<Unit> = {}): Unit {
  return { slug: 'doutor-hernia-boa-vista', systemPrompt: MANUAL, ...over } as Unit;
}

afterEach(() => {
  delete process.env.PROMPT_DA_UNIDADE_SLUGS;
});

test('sem o piloto ligado, nada muda: o config continua ganhando', () => {
  assert.equal(escolherBase(unidade(), GENERICO), GENERICO);
});

test('com a unidade no piloto, o manual dela ganha', () => {
  process.env.PROMPT_DA_UNIDADE_SLUGS = 'doutor-hernia-boa-vista';
  assert.equal(escolherBase(unidade(), GENERICO), MANUAL);
});

test('o piloto vale só para quem está na lista', () => {
  process.env.PROMPT_DA_UNIDADE_SLUGS = 'doutor-hernia-boa-vista';
  assert.equal(escolherBase(unidade({ slug: 'doutor-hernia-porto' }), GENERICO), GENERICO);
});

test('lista com várias unidades, com espaço no meio', () => {
  process.env.PROMPT_DA_UNIDADE_SLUGS = ' doutor-hernia-porto , doutor-hernia-boa-vista ';
  assert.equal(escolherBase(unidade(), GENERICO), MANUAL);
  assert.equal(escolherBase(unidade({ slug: 'doutor-hernia-porto' }), GENERICO), MANUAL);
});

test('o asterisco liga para todas', () => {
  process.env.PROMPT_DA_UNIDADE_SLUGS = '*';
  assert.equal(escolherBase(unidade({ slug: 'qualquer-uma' }), GENERICO), MANUAL);
});

test('unidade no piloto SEM manual próprio cai no config, não fica muda', () => {
  // Sem esta regra, ligar o piloto numa unidade recém-criada deixaria a IA sem
  // instrução nenhuma — pior do que o problema que estamos consertando.
  process.env.PROMPT_DA_UNIDADE_SLUGS = '*';
  assert.equal(escolherBase(unidade({ systemPrompt: '   ' }), GENERICO), GENERICO);
  assert.equal(escolherBase(unidade({ systemPrompt: null }), GENERICO), GENERICO);
});

test('sem config e sem manual, devolve indefinido em vez de string vazia', () => {
  assert.equal(escolherBase(unidade({ systemPrompt: '' }), ''), undefined);
  assert.equal(escolherBase(unidade({ systemPrompt: null }), undefined), undefined);
});

test('sem config, o manual da unidade é usado mesmo fora do piloto', () => {
  // É o comportamento que já existia e que faz o sistema funcionar em unidade
  // nova, antes de o AgentConfig ser semeado.
  assert.equal(escolherBase(unidade(), ''), MANUAL);
  assert.equal(escolherBase(unidade(), undefined), MANUAL);
});

test('lista vazia ou só vírgulas não liga o piloto sem querer', () => {
  for (const ruim of ['', '   ', ',,', ' , , ']) {
    process.env.PROMPT_DA_UNIDADE_SLUGS = ruim;
    assert.equal(escolherBase(unidade(), GENERICO), GENERICO, `lista "${ruim}" ligou o piloto`);
  }
});
