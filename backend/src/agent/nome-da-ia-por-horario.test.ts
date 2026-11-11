/**
 * Nome da IA por horário (Tatuí, 11/11/2026): Sara 00:00–13:29, Cíntia 13:30–23:59, no relógio de São Paulo.
 * Sem escala gravada a unidade tem UM nome, como sempre teve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeFollowUpSystemPrompt, composeSystemPrompt, composeSystemPromptParts, composeFlattenedPrompt } from './prompt-composer.js';
import {
  lerEscalaDeNomes,
  nomeDaEscalaNoHorario,
  renderColegasDeRecepcao,
  unidadeNoTurno,
} from './nome-da-ia-por-horario.js';

const ESCALA = [
  { desde: '00:00', nome: 'Sara' },
  { desde: '13:30', nome: 'Cíntia' },
];

function tatui(extra: Partial<Unit> = {}): Unit {
  return {
    id: 'u-tatui',
    slug: 'doutor-hernia-tatui',
    name: 'Doutor Hérnia Tatuí',
    category: 'saude',
    personaCompanyName: 'Doutor Hérnia Tatuí',
    personaAgentName: 'Sara',
    personaAgentNameSchedule: ESCALA,
    personaEmojis: [],
    handoffKeywords: [],
    collectNameEnabled: true,
    sourceProdutos: 'Consulta: R$ 250.',
    clinicAddress: null,
    spineTimezone: 'America/Sao_Paulo',
    ...extra,
  } as unknown as Unit;
}

// São Paulo é UTC−3 o ano todo (sem horário de verão desde 2019): 13:29 em SP = 16:29Z.
const SP = (hhmm: string) => new Date(`2026-11-11T${hhmm}:00-03:00`);

test('13:29 em São Paulo é a Sara; 13:30 é a Cíntia', () => {
  assert.equal(unidadeNoTurno(tatui(), SP('13:29')).personaAgentName, 'Sara');
  assert.equal(unidadeNoTurno(tatui(), SP('13:30')).personaAgentName, 'Cíntia');
});

test('as pontas do dia: 00:00 é Sara, 23:59 é Cíntia', () => {
  assert.equal(unidadeNoTurno(tatui(), SP('00:00')).personaAgentName, 'Sara');
  assert.equal(unidadeNoTurno(tatui(), SP('07:00')).personaAgentName, 'Sara');
  assert.equal(unidadeNoTurno(tatui(), SP('23:59')).personaAgentName, 'Cíntia');
});

test('vale o relógio de São Paulo, não o do servidor (UTC): 13:30Z é 10:30 em SP, ainda Sara', () => {
  assert.equal(unidadeNoTurno(tatui(), new Date('2026-11-11T13:30:00Z')).personaAgentName, 'Sara');
  // 16:30Z = 13:30 em SP
  assert.equal(unidadeNoTurno(tatui(), new Date('2026-11-11T16:30:00Z')).personaAgentName, 'Cíntia');
  // 02:59Z do dia seguinte = 23:59 em SP do dia anterior
  assert.equal(unidadeNoTurno(tatui(), new Date('2026-11-12T02:59:00Z')).personaAgentName, 'Cíntia');
  assert.equal(unidadeNoTurno(tatui(), new Date('2026-11-12T03:00:00Z')).personaAgentName, 'Sara');
});

test('respeita o fuso da unidade (Boa Vista é UTC−4)', () => {
  const bv = tatui({ spineTimezone: 'America/Boa_Vista' });
  // 17:29Z = 13:29 em Boa Vista
  assert.equal(unidadeNoTurno(bv, new Date('2026-11-11T17:29:00Z')).personaAgentName, 'Sara');
  assert.equal(unidadeNoTurno(bv, new Date('2026-11-11T17:30:00Z')).personaAgentName, 'Cíntia');
});

test('sem escala: devolve a MESMA unidade e o nome fixo (nenhuma outra unidade muda)', () => {
  const fixa = tatui({ personaAgentNameSchedule: null, personaAgentName: 'Aline' });
  assert.equal(unidadeNoTurno(fixa, SP('15:00')), fixa);
  assert.equal(unidadeNoTurno(fixa, SP('15:00')).personaAgentName, 'Aline');
});

test('escala torta ou vazia nunca derruba: segue o nome fixo', () => {
  for (const ruim of [[], {}, 'Sara', [{ desde: '25:00', nome: 'X' }], [{ desde: '13:30' }], [{ desde: '13:30', nome: '  ' }], [null, 3]]) {
    const u = tatui({ personaAgentNameSchedule: ruim as never, personaAgentName: 'Sara' });
    assert.equal(unidadeNoTurno(u, SP('15:00')).personaAgentName, 'Sara', JSON.stringify(ruim));
  }
});

test('a escala não precisa vir em ordem, e antes da primeira faixa vale a última (a da véspera)', () => {
  const desordenada = [
    { desde: '13:30', nome: 'Cíntia' },
    { desde: '07:00', nome: 'Sara' },
  ];
  assert.deepEqual(lerEscalaDeNomes(desordenada).map((f) => f.nome), ['Sara', 'Cíntia']);
  assert.equal(nomeDaEscalaNoHorario(desordenada, '06:59'), 'Cíntia');
  assert.equal(nomeDaEscalaNoHorario(desordenada, '07:00'), 'Sara');
  assert.equal(nomeDaEscalaNoHorario(desordenada, '13:29'), 'Sara');
});

test('o prompt do turno usa o nome do horário (persona + bloco da rede), conversa e follow-up', () => {
  const manha = composeSystemPromptParts({ unit: tatui(), agora: SP('10:00') }).cacheable;
  assert.match(manha, /Você é Sara, quem atende o WhatsApp/);
  assert.match(manha, /SEU NOME: você é a Sara — só "Sara"/);
  assert.doesNotMatch(manha, /Você é Cíntia/);

  const tarde = composeSystemPromptParts({ unit: tatui(), agora: SP('15:00') }).cacheable;
  assert.match(tarde, /Você é Cíntia, quem atende o WhatsApp/);
  assert.match(tarde, /SEU NOME: você é a Cíntia — só "Cíntia"/);
  assert.doesNotMatch(tarde, /Você é Sara/);

  assert.match(composeSystemPrompt({ unit: tatui(), agora: SP('15:00') }), /Você é Cíntia, quem atende/);
  assert.match(composeFlattenedPrompt({ unit: tatui(), agora: SP('15:00') }), /Você é Cíntia, quem atende/);
  assert.match(composeFollowUpSystemPrompt(tatui(), SP('15:00')), /Você é Cíntia, quem atende/);
  assert.match(composeFollowUpSystemPrompt(tatui(), SP('13:29')), /Você é Sara, quem atende/);
});

test('conversa que atravessa 13h30: a IA da tarde trata a Sara como colega, sem negar', () => {
  const tarde = composeSystemPromptParts({ unit: tatui(), agora: SP('15:00') }).cacheable;
  assert.match(tarde, /Na recepção também atende Sara, colega sua/);
  assert.match(tarde, /Nunca negue o que ela disse nem se apresente do zero/);
  const manha = composeSystemPromptParts({ unit: tatui(), agora: SP('09:00') }).cacheable;
  assert.match(manha, /Na recepção também atende Cíntia, colega sua/);
});

test('sem escala o prompt é o de sempre: nada de colega, nome fixo', () => {
  const fixa = tatui({ personaAgentNameSchedule: null, personaAgentName: 'Aline' });
  const p = composeSystemPromptParts({ unit: fixa, agora: SP('15:00') }).cacheable;
  assert.match(p, /Você é Aline, quem atende/);
  assert.doesNotMatch(p, /Na recepção também atende/);
  assert.equal(renderColegasDeRecepcao(fixa), '');
  // escala com um nome só também não inventa colega
  assert.equal(renderColegasDeRecepcao(tatui({ personaAgentNameSchedule: [{ desde: '00:00', nome: 'Sara' }] as never })), '');
});

test('o prompt de uma unidade com escala bate com o de uma unidade de nome fixo, fora a frase da colega', () => {
  const comEscala = composeSystemPromptParts({ unit: tatui(), agora: SP('10:00') }).cacheable;
  const fixa = composeSystemPromptParts({ unit: tatui({ personaAgentNameSchedule: null }), agora: SP('10:00') }).cacheable;
  const semFrase = comEscala.split('\n').filter((l) => !l.startsWith('Na recepção também atende')).join('\n');
  assert.equal(semFrase, fixa);
});

test('prompt escrito à mão (singlePromptMode): o bloco da rede traz o nome do horário e a colega entra', () => {
  const u = tatui({ singlePromptMode: true, systemPrompt: 'Você é a Sara.' } as Partial<Unit>);
  const tarde = composeSystemPromptParts({ unit: u, agora: SP('15:00') }).cacheable;
  assert.match(tarde, /SEU NOME: você é a Cíntia — só "Cíntia"/);
  assert.match(tarde, /Na recepção também atende Sara, colega sua/);
  assert.match(composeSystemPrompt({ unit: u, agora: SP('15:00') }), /Na recepção também atende Sara, colega sua/);
});

test('a colega não é inventada: a frase proíbe dizer que ela passou o caso se não aparece na conversa', () => {
  const p = renderColegasDeRecepcao(unidadeNoTurno(tatui(), SP('15:00')));
  assert.match(p, /não invente que ela te passou o caso/);
  assert.doesNotMatch(p, /me passou o seu caso/);
});

test('o mesmo nome repetido na escala (maiúscula/minúscula) não vira colega', () => {
  const u = unidadeNoTurno(
    tatui({ personaAgentNameSchedule: [{ desde: '00:00', nome: 'Sara' }, { desde: '10:00', nome: 'sara' }, { desde: '13:30', nome: 'Cíntia' }] as never }),
    SP('14:00'),
  );
  assert.match(renderColegasDeRecepcao(u), /também atende Sara, colega sua/);
});
