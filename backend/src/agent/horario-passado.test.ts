/**
 * Item 1 da auditoria de Araguaína (21/10/2026): horário que já passou, tirado de uma consulta velha à agenda.
 *
 * Lead 28743600: em 17/10 17:53 a Sofia ofereceu "segunda-feira, 19/10: às 08h, 14h ou 16h". Em 19/10 às 08:29
 * ofereceu de novo "segunda (19/10) às 08h, 14h ou 16h" — o das 08h já tinha passado, e ela não consultou a agenda.
 * Estes testes prendem: a leitura dos horários oferecidos (com o dia de cada um), o carimbo que consultar_horarios
 * põe no resultado, a decisão da trava (reconsultar / cortar / deixar passar) e o caminho do grafo para a reconsulta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { END, START, StateGraph, MessagesAnnotation } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Unit } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { SpineService } from '../services/spine.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { buildConsultarHorarios } from './agenda-tools.js';
import { composeSystemPrompt } from './prompt-composer.js';
import {
  carimboDaConsulta,
  consultaAindaVale,
  consultasDaAgenda,
  horariosOferecidos,
  horariosQueJaPassaram,
  ofertaDaConsultaDoTurno,
  PERGUNTA_DO_DIA,
  quandoFoiConsultada,
  reconsultaDaAgenda,
  semHorarioPassado,
  travaDoHorario,
  type ConsultaDaAgenda,
} from './horario-oferecido.js';

// As falas reais do cartão 28743600 (Araguaína).
const OFERTA_17_10 =
  'Que alegria, Antônia! ✨ Vamos sim cuidar dessa dor direito.\n\nTenho horários disponíveis na segunda-feira, 19/10: às 08h, 14h ou 16h. Me confirma seu nome completo (já tenho "Antônia Gomes") e qual desses horários fica melhor pra você? ☺';
const OFERTA_19_10 =
  'Antônia, pra eu deixar tudo certo: consegue me dizer se prefere o horário de segunda (19/10) às 08h, 14h ou 16h? ☺ Assim já encaminho pra equipe confirmar sua vaga!';
const PRECO_17_10 =
  'A consulta é R$ 350 pagando na clínica no dia, ou R$ 250 se você pagar antes, antecipado por Pix — é o Pix que garante sua reserva no horário.\n\nPensando no seu caso, qual desses horários de segunda (19/10) fica melhor: 08h, 14h ou 16h? ☺';

const CONSULTA_DE_17_10: ConsultaDaAgenda = { noTurno: false, em: '2026-10-17T17:53', confirmados: true };

// ── A leitura dos horários ──────────────────────────────────────────────────────────────────────────────

test('lê os horários oferecidos e o dia de cada um (a data escrita manda sobre o dia da semana)', () => {
  const o = horariosOferecidos(OFERTA_17_10, '2026-10-17T17:53');
  assert.deepEqual(
    o.map((x) => `${x.data} ${x.hora}`),
    ['2026-10-19 08:00', '2026-10-19 14:00', '2026-10-19 16:00'],
  );
  assert.deepEqual(
    horariosOferecidos(OFERTA_19_10, '2026-10-19T08:29').map((x) => `${x.data} ${x.hora}`),
    ['2026-10-19 08:00', '2026-10-19 14:00', '2026-10-19 16:00'],
  );
  // só o dia da semana: a próxima segunda a partir de hoje (sábado 17/10 → 19/10)
  assert.deepEqual(
    horariosOferecidos('Prefere a segunda às 08h ou às 14h?', '2026-10-17T18:20').map((x) => `${x.data} ${x.hora}`),
    ['2026-10-19 08:00', '2026-10-19 14:00'],
  );
  // a data dita numa frase vale para a pergunta da frase seguinte
  assert.deepEqual(
    horariosOferecidos('Tenho vaga amanhã. Fica melhor às 9h30 ou às 15h?', '2026-10-20T10:00').map((x) => `${x.data} ${x.hora}`),
    ['2026-10-21 09:30', '2026-10-21 15:00'],
  );
  // os botões, com o dia abreviado: o dia vem da data escrita antes
  assert.deepEqual(
    horariosOferecidos('Tenho segunda (19/10). Qual fica melhor?\n[[botoes: Seg 08h | Seg 14h]]', '2026-10-19T08:29').map((x) => `${x.data} ${x.hora}`),
    ['2026-10-19 08:00', '2026-10-19 14:00'],
  );
  // "terça" dita numa terça, com a data da semana que vem escrita antes: é a da semana que vem, não hoje
  assert.deepEqual(
    horariosOferecidos('Tenho terça-feira, 27/10, às 09h ou às 14h30. Prefere a terça às 09h?\n[[botoes: Ter 09h | Ter 14h30]]', '2026-10-20T10:00').map((x) => `${x.data} ${x.hora}`),
    ['2026-10-27 09:00', '2026-10-27 14:30', '2026-10-27 09:00', '2026-10-27 09:00', '2026-10-27 14:30'],
  );
  // botão com o dia por extenso: uma marca só por dia ("Ter" não conta de novo dentro de "Terça")
  assert.deepEqual(
    horariosOferecidos('[[botoes: Terça 09h | Quarta 14h]]', '2026-10-19T10:00').map((x) => `${x.data} ${x.hora}`),
    ['2026-10-20 09:00', '2026-10-21 14:00'],
  );
  // só "segunda", dito numa segunda, sem data: pode ser hoje ou a semana que vem — o dia fica desconhecido
  assert.deepEqual(
    horariosOferecidos('Prefere a segunda às 08h ou às 14h?', '2026-10-19T10:00').map((x) => `${x.data} ${x.hora}`),
    ['null 08:00', 'null 14:00'],
  );
});

test('consulta que ele já tem, expediente, duração e preço não são horário oferecido', () => {
  for (const t of [
    '✅ Agendamento confirmado, Antônia!\n\n⭐ Data: segunda-feira, 19/10\n⏰ Horário: 16:00\n\nQualquer dúvida, é só chamar. Até breve!',
    'Sua consulta é segunda, 19/10, às 16h. Te espero!',
    'Sua consulta está marcada para segunda às 16h — posso confirmar sua presença?',
    'A clínica atende das 8h às 18h, de segunda a sexta. Quer que eu veja os horários?',
    'A consulta dura cerca de 1h e é presencial. Quer que eu veja um horário?',
    'Com Pix antecipado fica R$ 250 (garante sua vaga), ou R$ 350 se preferir pagar no dia ☺',
  ]) {
    assert.deepEqual(horariosOferecidos(t, '2026-10-19T08:29'), [], t);
  }
});

test('o das 08h de 19/10 já tinha passado às 08:29 de 19/10 — os das 14h e 16h não', () => {
  const passados = horariosQueJaPassaram(horariosOferecidos(OFERTA_19_10, '2026-10-19T08:29'), '2026-10-19T08:29');
  assert.deepEqual(passados.map((p) => p.hora), ['08:00']);
  // em 17/10, nenhum tinha passado
  assert.deepEqual(horariosQueJaPassaram(horariosOferecidos(OFERTA_17_10, '2026-10-17T17:53'), '2026-10-17T17:53'), []);
});

// ── O carimbo da consulta à agenda ──────────────────────────────────────────────────────────────────────

test('o carimbo da consulta vai e volta, e vale só no mesmo dia, por algumas horas', () => {
  const carimbo = carimboDaConsulta('2026-10-17T17:53:12');
  assert.match(carimbo, /Agenda consultada em 17\/10\/2026 às 17:53/);
  assert.match(carimbo, /chame consultar_horarios de novo/);
  assert.equal(quandoFoiConsultada(`Horários CONFIRMADOS com a clínica em segunda-feira, 19/10/2026 (2026-10-19): 08:00, 14:00, 16:00. ${carimbo}`), '2026-10-17T17:53');
  assert.equal(quandoFoiConsultada('Horários CONFIRMADOS com a clínica em segunda-feira (2026-10-19): 08:00.'), null);
  assert.equal(consultaAindaVale('2026-10-17T17:53', '2026-10-17T18:14'), true); // 21 min depois: a conversa seguindo
  assert.equal(consultaAindaVale('2026-10-17T17:53', '2026-10-17T21:30'), false); // horas depois
  assert.equal(consultaAindaVale('2026-10-17T17:53', '2026-10-19T08:29'), false); // outro dia
  // relógio de parede local: 21:30 → 23:50 do mesmo dia na clínica vale, mesmo virando o dia em UTC
  assert.equal(consultaAindaVale('2026-10-17T21:30', '2026-10-17T23:50'), true);
  assert.equal(consultaAindaVale('2026-10-17T23:50', '2026-10-18T00:10'), false); // passou da meia-noite local
});

test('consultar_horarios devolve a lista com a hora da consulta carimbada', async () => {
  const unidade = {
    id: 'u-ara',
    slug: 'doutor-hernia-araguaina',
    name: 'Araguaína',
    spineEnabled: true,
    spineToken: 'tok',
    spineTimezone: 'America/Araguaina',
    spineAgendaDays: [1, 2, 3, 4, 5],
    spineAgendaStart: '08:00',
    spineAgendaEnd: '18:00',
    spineLunchStart: '12:00',
    spineLunchEnd: '14:00',
    spineSlotMinutes: 60,
    spineDayHours: null,
  } as unknown as Unit;
  Object.defineProperty(prisma, 'unit', { value: { findUnique: async () => unidade }, configurable: true });
  Object.defineProperty(prisma, 'spineLeadLink', { value: { findFirst: async () => null }, configurable: true });
  Object.defineProperty(prisma, 'agendaBlock', { value: { findMany: async () => [] }, configurable: true });
  Object.defineProperty(prisma, 'unitCrmCompartilhado', { value: { findMany: async () => [] }, configurable: true });
  (SpineService as unknown as Record<string, unknown>).searchSchedules = async () => ({ ok: true, data: { schedules: [] } });
  const recorder = { step: async () => undefined } as unknown as TraceRecorder;
  const texto = String(await buildConsultarHorarios({ unit: unidade, recorder }).invoke({ data: '2026-12-01' }));
  assert.match(texto, /Horários CONFIRMADOS/);
  assert.ok(quandoFoiConsultada(texto), `sem carimbo: ${texto}`);
});

test('acha os resultados de consultar_horarios na conversa e diz quais são do turno em curso', () => {
  const carimbo = carimboDaConsulta('2026-10-17T17:53');
  const msgs = [
    new HumanMessage('[áudio]: pode ver pra mim'),
    new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'consultar_horarios', args: { data: '2026-10-19' } }] }),
    // resultado antigo pode chegar sem `name`: o nome sai da chamada
    new ToolMessage({ content: `Horários CONFIRMADOS com a clínica em segunda-feira, 19/10/2026 (2026-10-19): 08:00, 14:00, 16:00. ${carimbo}`, tool_call_id: 'c1' }),
    new AIMessage(OFERTA_17_10),
    new HumanMessage('tabom'),
    new AIMessage({ content: '', tool_calls: [{ id: 'c2', name: 'consultar_horarios', args: { data: '2026-10-19' } }] }),
    new ToolMessage({ content: 'Horários CONFIRMADOS com a clínica em segunda-feira (2026-10-19): 14:00, 16:00.', tool_call_id: 'c2', name: 'consultar_horarios' }),
  ];
  assert.deepEqual(consultasDaAgenda(msgs), [
    { noTurno: false, em: '2026-10-17T17:53', confirmados: true },
    { noTurno: true, em: null, confirmados: true },
  ]);
});

// ── A trava ─────────────────────────────────────────────────────────────────────────────────────────────

test('19/10 08:29: ofereceu o das 08h de hoje, com a agenda de 17/10 → reconsulta a partir de hoje', () => {
  const t = travaDoHorario({ texto: OFERTA_19_10, agoraLocal: '2026-10-19T08:29', consultas: [CONSULTA_DE_17_10], ferramentas: [], jaReconsultou: false });
  assert.equal(t?.acao, 'reconsultar');
  assert.equal(t?.acao === 'reconsultar' && t.data, '2026-10-19');
  assert.match(t?.motivo ?? '', /já passou \(19\/10 08:00; agora 19\/10 08:29\)/);
});

test('dia seguinte, nenhum horário passou, mas a agenda é de ontem → reconsulta a partir do dia oferecido', () => {
  const t = travaDoHorario({ texto: PRECO_17_10, agoraLocal: '2026-10-18T10:00', consultas: [CONSULTA_DE_17_10], ferramentas: [], jaReconsultou: false });
  assert.equal(t?.acao, 'reconsultar');
  assert.equal(t?.acao === 'reconsultar' && t.data, '2026-10-19');
  assert.match(t?.motivo ?? '', /consulta à agenda de 17\/10 17:53/);
});

test('a conversa seguindo minutos depois, com a agenda de agora, passa', () => {
  // 17/10 17:58: o preço, repetindo os horários consultados às 17:53
  assert.equal(travaDoHorario({ texto: PRECO_17_10, agoraLocal: '2026-10-17T17:58', consultas: [CONSULTA_DE_17_10], ferramentas: [], jaReconsultou: false }), null);
  // consultou neste turno
  assert.equal(
    travaDoHorario({ texto: PRECO_17_10, agoraLocal: '2026-10-18T10:00', consultas: [CONSULTA_DE_17_10, { noTurno: true, em: '2026-10-18T10:00', confirmados: true }], ferramentas: ['consultar_horarios'], jaReconsultou: false }),
    null,
  );
  // resultado antigo, sem carimbo (de antes da trava): não dá para saber a idade
  assert.equal(travaDoHorario({ texto: PRECO_17_10, agoraLocal: '2026-10-18T10:00', consultas: [{ noTurno: false, em: null, confirmados: true }], ferramentas: [], jaReconsultou: false }), null);
  // resposta sem horário
  assert.equal(travaDoHorario({ texto: 'Faz sentido, Antônia. Quer que eu veja os horários?', agoraLocal: '2026-10-19T08:29', consultas: [CONSULTA_DE_17_10], ferramentas: [], jaReconsultou: false }), null);
});

test('horário oferecido sem nenhuma consulta à agenda na conversa → reconsulta', () => {
  const t = travaDoHorario({ texto: 'Tenho horário segunda-feira, 19/10, às 08h ou às 14h — qual fica melhor pra você?', agoraLocal: '2026-10-17T18:19', consultas: [], ferramentas: [], jaReconsultou: false });
  assert.equal(t?.acao, 'reconsultar');
  assert.match(t?.motivo ?? '', /sem ter consultado a agenda/);
});

test('já reconsultou neste turno e ainda saiu horário que passou → o horário sai da resposta', () => {
  const t = travaDoHorario({ texto: OFERTA_19_10, agoraLocal: '2026-10-19T08:29', consultas: [CONSULTA_DE_17_10, { noTurno: true, em: '2026-10-19T08:29', confirmados: true }], ferramentas: ['consultar_horarios'], jaReconsultou: true });
  assert.equal(t?.acao, 'cortar_passado');

  const cortado = semHorarioPassado(OFERTA_19_10, '2026-10-19T08:29');
  assert.doesNotMatch(cortado, /08h/);
  assert.match(cortado, /Assim já encaminho/);
  assert.ok(cortado.endsWith(PERGUNTA_DO_DIA), cortado);
  // a resposta inteira era o horário vencido: fica só a pergunta do dia
  assert.equal(semHorarioPassado('Fica melhor hoje às 08h ou às 09h? ☺\n[[botoes: Hoje 08h | Hoje 09h]]', '2026-10-19T10:00'), PERGUNTA_DO_DIA);
  // sem horário vencido, nada muda
  assert.equal(semHorarioPassado(OFERTA_17_10, '2026-10-17T17:53'), OFERTA_17_10);
});

test('com a agenda do turno na mão, a frase do horário vencido vira os horários de agora (os que valem não somem)', () => {
  const msgs = [
    new HumanMessage('tabom'),
    new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'consultar_horarios', args: { data: '2026-10-19' } }] }),
    new ToolMessage({
      content: `Horários CONFIRMADOS com a clínica em segunda-feira, 19/10/2026 (2026-10-19): 14:00, 16:00. ${carimboDaConsulta('2026-10-19T08:29')}`,
      tool_call_id: 'c1',
      name: 'consultar_horarios',
    }),
  ];
  const oferta = ofertaDaConsultaDoTurno(msgs);
  assert.equal(oferta, 'Tenho segunda-feira, 19/10, às 14h ou às 16h. Qual fica melhor pra você?');
  assert.equal(
    semHorarioPassado(OFERTA_19_10, '2026-10-19T08:29', oferta),
    'Tenho segunda-feira, 19/10, às 14h ou às 16h. Qual fica melhor pra você? Assim já encaminho pra equipe confirmar sua vaga!',
  );
});

// ── O prompt ────────────────────────────────────────────────────────────────────────────────────────────

test('o prompt da agenda manda reconsultar horário oferecido em outro dia', () => {
  const unidade = {
    id: 'u1',
    slug: 'teste',
    name: 'Clínica Teste',
    spineEnabled: true,
    spineAgendaStart: '08:00',
    spineAgendaEnd: '18:00',
    spineAgendaDays: [1, 2, 3, 4, 5],
    personaEmojis: [],
    handoffKeywords: [],
  } as unknown as Unit;
  const prompt = composeSystemPrompt({ unit: unidade });
  assert.match(prompt, /Horário que VOCÊ ofereceu em outro dia \(ou horas atrás\) não vale mais/);
  assert.match(prompt, /Consulte de novo antes de oferecer outra\s+vez/);
});

// ── O caminho no grafo ──────────────────────────────────────────────────────────────────────────────────

test('a reconsulta montada pelo código roda consultar_horarios e volta ao agente com a agenda do turno', async () => {
  const pedidas: string[] = [];
  const consultar = new DynamicStructuredTool({
    name: 'consultar_horarios',
    description: 'teste',
    schema: z.object({ data: z.string() }),
    func: async ({ data }) => {
      pedidas.push(data);
      return `Horários CONFIRMADOS com a clínica em segunda-feira (${data}): 14:00, 16:00. ${carimboDaConsulta('2026-10-19T08:29')}`;
    },
  });
  let passagens = 0;
  const agente = async (state: typeof MessagesAnnotation.State) => {
    passagens++;
    const t = travaDoHorario({
      texto: OFERTA_19_10,
      agoraLocal: '2026-10-19T08:29',
      consultas: consultasDaAgenda(state.messages),
      ferramentas: [],
      jaReconsultou: passagens > 1,
    });
    if (t?.acao === 'reconsultar') return { messages: [reconsultaDaAgenda(t.data)] };
    return { messages: [new AIMessage('Tenho segunda (19/10) às 14h ou às 16h. Qual fica melhor pra você? ☺')] };
  };
  const continuar = (state: typeof MessagesAnnotation.State) => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    return Array.isArray(last.tool_calls) && last.tool_calls.length > 0 ? 'tools' : END;
  };
  const grafo = new StateGraph(MessagesAnnotation)
    .addNode('agent', agente)
    .addNode('tools', new ToolNode([consultar]))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', continuar, { tools: 'tools', [END]: END })
    .addEdge('tools', 'agent')
    .compile();
  const fim = await grafo.invoke({ messages: [new HumanMessage('tabom')] });
  assert.deepEqual(pedidas, ['2026-10-19']);
  assert.equal(passagens, 2);
  const ultima = fim.messages[fim.messages.length - 1];
  assert.match(String(ultima.content), /14h ou às 16h/);
  assert.deepEqual(consultasDaAgenda(fim.messages), [{ noTurno: true, em: '2026-10-19T08:29', confirmados: true }]);
});
