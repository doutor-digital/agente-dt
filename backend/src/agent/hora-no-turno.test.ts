/**
 * Tatuí (doutor-hernia-tatui), 12–19/11/2026: o papel manda abrir com "Olá, [bom dia/boa tarde/boa noite]" e assinar Sara
 * (00h00–13h29) ou Cíntia (13h30–23h59), mas o prompt não leva a hora — de propósito, por causa do cache. Medido em 7 dias:
 * 27 aberturas, 14 com «Cíntia» antes das 13h30, 2 com «Sara» depois.
 *
 * O que estes testes prendem:
 *  - a hora chega pelo bloco do TURNO (`dynamic`), nunca pelo prefixo cacheado: o `cacheable` é byte a byte o mesmo em duas horas;
 *  - sem a chave `hora-no-turno`, nada muda em lugar nenhum (nem `cacheable` nem `dynamic`);
 *  - dia da semana e hora saem do fuso da unidade, calculados em código.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Unit } from '@prisma/client';

import { renderAgoraDoTurno } from '../lib/feriados.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import { composeSystemPrompt, composeSystemPromptParts } from './prompt-composer.js';

function tatui(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-tatui', slug: 'doutor-hernia-tatui', name: 'Doutor Hérnia Tatuí', category: 'saude',
    systemPrompt: null, personaResponseLength: 'normal', personaLanguage: 'pt-BR', personaEmojis: [], handoffKeywords: [],
    pipelineIntents: null, spineEnabled: false, spineAgendaDays: [1, 2, 3, 4, 5],
    businessHoursTimezone: 'America/Sao_Paulo', spineTimezone: 'America/Sao_Paulo', sourceProdutos: null,
    sourcePapel: 'Olá, [bom dia/boa tarde/boa noite] {nome}! Me chamo [Sara/Cíntia, conforme o turno]',
    ...over,
  } as unknown as Unit;
}

// quinta-feira 19/11/2026: 12:12 UTC = 09:12 em São Paulo; 17:44 UTC = 14:44
const MANHA = new Date('2026-11-19T12:12:00Z');
const TARDE = new Date('2026-11-19T17:44:00Z');

test('renderAgoraDoTurno: dia da semana, data e hora no fuso da unidade', () => {
  assert.equal(renderAgoraDoTurno(TARDE, 'America/Sao_Paulo'), 'Agora: quinta-feira 19/11, 14:44 (horário da clínica).');
  assert.equal(renderAgoraDoTurno(MANHA, 'America/Sao_Paulo'), 'Agora: quinta-feira 19/11, 09:12 (horário da clínica).');
});

test('renderAgoraDoTurno: a virada do dia segue o fuso, não o UTC', () => {
  // 02:30 UTC de sexta 20/11 ainda é quinta 19/11 23:30 em São Paulo
  assert.equal(renderAgoraDoTurno(new Date('2026-11-20T02:30:00Z'), 'America/Sao_Paulo'), 'Agora: quinta-feira 19/11, 23:30 (horário da clínica).');
  // meia-noite local: «00:05», nunca «24:05»
  assert.equal(renderAgoraDoTurno(new Date('2026-11-20T03:05:00Z'), 'America/Sao_Paulo'), 'Agora: sexta-feira 20/11, 00:05 (horário da clínica).');
  // fuso de outra unidade (Manaus, UTC-4)
  assert.equal(renderAgoraDoTurno(TARDE, 'America/Manaus'), 'Agora: quinta-feira 19/11, 13:44 (horário da clínica).');
});

test('renderAgoraDoTurno: fuso inválido cai em São Paulo em vez de derrubar o atendimento', () => {
  assert.equal(renderAgoraDoTurno(TARDE, 'America Sao Paulo'), 'Agora: quinta-feira 19/11, 14:44 (horário da clínica).');
});

test('com a chave ligada, a hora vai no bloco do turno e o prefixo cacheado não muda entre turnos', () => {
  const manha = composeSystemPromptParts({ unit: tatui(), leadId: 1, horaNoTurno: true, agora: MANHA, userMessage: 'oi' });
  const tarde = composeSystemPromptParts({ unit: tatui(), leadId: 1, horaNoTurno: true, agora: TARDE, userMessage: 'oi' });

  assert.equal(manha.cacheable, tarde.cacheable, 'o que o Anthropic cacheia é idêntico em duas horas do mesmo dia');
  assert.doesNotMatch(manha.cacheable, /<agora>|Agora:|09:12|14:44/, 'hora nenhuma no prefixo cacheado');
  assert.match(manha.dynamic, /<agora>\nAgora: quinta-feira 19\/11, 09:12 \(horário da clínica\)\./);
  assert.match(tarde.dynamic, /<agora>\nAgora: quinta-feira 19\/11, 14:44 \(horário da clínica\)\./);
  assert.notEqual(manha.dynamic, tarde.dynamic);
  assert.ok(manha.dynamic.startsWith('<agora>'), 'primeiro do bloco do turno');
});

test('sem a chave, nada muda: nem prefixo nem bloco do turno trazem hora', () => {
  const manha = composeSystemPromptParts({ unit: tatui(), leadId: 1, agora: MANHA, userMessage: 'oi' });
  const tarde = composeSystemPromptParts({ unit: tatui(), leadId: 1, agora: TARDE, userMessage: 'oi' });
  const desligada = composeSystemPromptParts({ unit: tatui(), leadId: 1, horaNoTurno: false, agora: TARDE, userMessage: 'oi' });

  assert.deepEqual(manha, tarde, 'a hora passada não vaza sem a chave');
  assert.deepEqual(manha, desligada);
  assert.doesNotMatch(manha.cacheable + manha.dynamic, /<agora>|Agora:/);
});

test('prompt único escrito à mão: a hora também vai no bloco do turno, não no prefixo', () => {
  const u = tatui({ singlePromptMode: true, systemPrompt: 'Você é a Sofia.' } as Partial<Unit>);
  const manha = composeSystemPromptParts({ unit: u, leadId: 1, horaNoTurno: true, agora: MANHA });
  const tarde = composeSystemPromptParts({ unit: u, leadId: 1, horaNoTurno: true, agora: TARDE });
  assert.equal(manha.cacheable, tarde.cacheable);
  assert.doesNotMatch(manha.cacheable, /Agora:/);
  assert.match(tarde.dynamic, /Agora: quinta-feira 19\/11, 14:44/);
});

test('caminho de um texto só (modelo que não é Anthropic): a hora entra com a chave e só com ela', () => {
  assert.match(composeSystemPrompt({ unit: tatui(), leadId: 1, horaNoTurno: true, agora: TARDE }), /<agora>\nAgora: quinta-feira 19\/11, 14:44/);
  assert.doesNotMatch(composeSystemPrompt({ unit: tatui(), leadId: 1, agora: TARDE }), /Agora:/);
  const u = tatui({ singlePromptMode: true, systemPrompt: 'Você é a Sofia.' } as Partial<Unit>);
  assert.match(composeSystemPrompt({ unit: u, leadId: 1, horaNoTurno: true, agora: TARDE }), /Agora: quinta-feira 19\/11, 14:44/);
  assert.doesNotMatch(composeSystemPrompt({ unit: u, leadId: 1, agora: TARDE }), /Agora:/);
});

test('a chave nasce desligada na rede toda e liga por unidade (HORA_NO_TURNO_SLUGS)', () => {
  assert.equal(automacaoLigada('doutor-hernia-tatui', 'hora-no-turno', undefined), false, 'sem a variável, ninguém');
  assert.equal(automacaoLigada('doutor-hernia-tatui', 'hora-no-turno', ''), false);
  assert.equal(automacaoLigada('doutor-hernia-tatui', 'hora-no-turno', 'doutor-hernia-tatui'), true);
  assert.equal(automacaoLigada('doutor-hernia-salto', 'hora-no-turno', 'doutor-hernia-tatui'), false, 'Salto fica de fora');
});

// O fio entre a chave e o prompt só existe em código que precisa de banco para rodar (loadComposeInput) e no grafo: confere o texto,
// como faz robos-automacoes.test.ts. Se alguém tirar um dos dois, a hora some do prompt de Tatuí sem nenhum outro teste ficar vermelho.
const fonte = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('o fio: a chave HORA_NO_TURNO_SLUGS vira horaNoTurno, e o grafo fixa UMA hora por turno nos dois caminhos', () => {
  const composer = fonte('./prompt-composer.ts');
  assert.match(composer, /horaNoTurno: automacaoLigada\(input\.unit\.slug, 'hora-no-turno', process\.env\.HORA_NO_TURNO_SLUGS\)/);
  const grafo = fonte('./graph.ts');
  assert.match(grafo, /const agoraDoTurno = new Date\(\);\n\n  const agentNode/, 'fixada fora do nó: ele roda de novo a cada volta de ferramenta');
  assert.equal(grafo.match(/agora: agoraDoTurno,/g)?.length, 2, 'caminho Anthropic e caminho de texto único');
});
