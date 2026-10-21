/**
 * Item 2 da auditoria de Araguaína (21/10/2026): "manhã ou tarde?" no lugar de dois horários concretos.
 *
 * Leads 28686476, 28743362, 28655414 ("de manhã ou à tarde costuma ser melhor pra você?") e 28681456 ("prefere vir
 * pela manhã ou à tarde?"). O prompt já mandava "consultar horários e oferecer DUAS opções". Agora: o prompt proíbe a
 * pergunta do turno (só vale quando a agenda não devolve horário), e a resposta que pergunta o turno sem horário
 * nenhum faz o grafo consultar a agenda — ou, se ela já foi consultada neste turno, refazer UMA vez com dois horários.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';
import { INSTRUCAO_REFAZER_TURNO, perguntaTurnoSemHorario, travaDoHorario, type ConsultaDaAgenda } from './horario-oferecido.js';

const AGORA = '2026-10-20T10:15';
const ARAGUAINA_28655414 = 'Entendi, Maria, faz sentido querer resolver logo. Pra eu ver a agenda: de manhã ou à tarde costuma ser melhor pra você?';
const ARAGUAINA_28681456 = 'Perfeito! A consulta é com o nosso especialista, presencial. Você prefere vir pela manhã ou à tarde?';

test('as perguntas de turno das conversas de Araguaína são pegas', () => {
  assert.equal(perguntaTurnoSemHorario(ARAGUAINA_28655414, AGORA), true);
  assert.equal(perguntaTurnoSemHorario(ARAGUAINA_28681456, AGORA), true);
  assert.equal(perguntaTurnoSemHorario('Qual período fica melhor pra você vir?', AGORA), true);
  assert.equal(perguntaTurnoSemHorario('Fica melhor de manhã ou de tarde? ☺\n[[botoes: Manhã | Tarde]]', AGORA), true);
});

test('com horário concreto, ou falando de ligação/contato, não é a pergunta do turno', () => {
  for (const t of [
    'Tenho horário segunda-feira, 19/10, às 08h ou às 14h — qual fica melhor pra você?',
    // 28740960, 19/10 09:31: a hora de procurar o paciente, não a da consulta
    'Tudo bem, Aldeones, sem pressa nenhuma ☺ Te chamo mais tarde então pra gente ver o melhor horário pra sua consulta. Fica melhor eu te procurar à tarde ou à noite?',
    'Se preferir, alguém da equipe te liga. Prefere que a gente ligue de manhã ou à tarde?',
    'Atendemos de manhã e à tarde, de segunda a sexta.',
  ]) {
    assert.equal(perguntaTurnoSemHorario(t, AGORA), false, t);
  }
});

test('sem consultar a agenda neste turno → o grafo consulta (a partir de amanhã)', () => {
  const t = travaDoHorario({ texto: ARAGUAINA_28655414, agoraLocal: AGORA, consultas: [], ferramentas: [], jaReconsultou: false });
  assert.deepEqual(t, { acao: 'reconsultar', motivo: 'perguntou "manhã ou tarde?" em vez de oferecer dois horários', data: '2026-10-21' });
  // uma consulta antiga não muda nada: a pergunta do turno pede a agenda de agora
  const antiga: ConsultaDaAgenda = { noTurno: false, em: '2026-10-20T09:50', confirmados: true };
  assert.equal(travaDoHorario({ texto: ARAGUAINA_28681456, agoraLocal: AGORA, consultas: [antiga], ferramentas: [], jaReconsultou: false })?.acao, 'reconsultar');
});

test('a agenda já devolveu horários neste turno e ela perguntou o turno → refaz UMA vez com dois horários', () => {
  const doTurno: ConsultaDaAgenda = { noTurno: true, em: AGORA, confirmados: true };
  const t = travaDoHorario({ texto: ARAGUAINA_28681456, agoraLocal: AGORA, consultas: [doTurno], ferramentas: ['consultar_horarios'], jaReconsultou: true });
  assert.equal(t?.acao, 'refazer_turno');
  assert.match(INSTRUCAO_REFAZER_TURNO, /DOIS horários concretos/);
  assert.match(INSTRUCAO_REFAZER_TURNO, /sem perguntar o turno/);
});

test('quando a agenda não deu horário, perguntar a preferência é o certo', () => {
  // a consulta deste turno não achou vaga ("Não encontrei horário livre…"): o turno serve para o encaixe pela equipe
  const semVaga: ConsultaDaAgenda = { noTurno: true, em: AGORA, confirmados: false };
  assert.equal(travaDoHorario({ texto: ARAGUAINA_28681456, agoraLocal: AGORA, consultas: [semVaga], ferramentas: ['consultar_horarios'], jaReconsultou: false }), null);
  // agenda cheia: registrou a preferência e passou para a equipe (o roteiro do prompt)
  for (const f of ['registra_preferencia_horario', 'pausar_ia', 'resumir_lead_para_sdr']) {
    assert.equal(travaDoHorario({ texto: ARAGUAINA_28655414, agoraLocal: AGORA, consultas: [], ferramentas: [f], jaReconsultou: false }), null, f);
  }
});

test('o prompt proíbe "manhã ou tarde?" no lugar dos dois horários', () => {
  const unidade = {
    id: 'u1',
    slug: 'teste',
    name: 'Clínica Teste',
    spineEnabled: true,
    spineAgendaStart: '08:00',
    spineAgendaEnd: '18:00',
    spineAgendaDays: [1, 2, 3, 4, 5],
    // com o preço nas fontes entra o bloco de conversão, onde fica a tabela de estados
    sourceProdutos: 'Consulta com o especialista: R$ 350 no dia ou R$ 250 antecipado no Pix.',
    personaEmojis: [],
    handoffKeywords: [],
  } as unknown as Unit;
  const prompt = composeSystemPrompt({ unit: unidade });
  assert.match(prompt, /Ofereça DOIS horários concretos \(dia da semana \+ DD\/MM \+ hora\)/);
  assert.match(prompt, /NUNCA pergunte "manhã ou tarde\?" nem "qual turno\?"/);
  assert.match(prompt, /Só pergunte a preferência quando a agenda\s+não devolver horário/);
  assert.match(prompt, /concretas \(nunca "manhã ou tarde\?"\)/);
});
