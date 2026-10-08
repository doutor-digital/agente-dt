/**
 * Açailândia, 08/10/2026 11:16 (quinta), cartão de teste 28088906 em PERDIDO. O paciente mandou
 * "oi, teste" e a Sofia de resgate respondeu "Tudo certo com sua consulta de quarta, 07/10 às 13h com a
 * fisioterapeuta Aylana — posso te ajudar em mais alguma coisa antes do seu dia?". A consulta tinha
 * sido ONTEM, e o nome da profissional saiu de mensagens de 06/10.
 *
 * As falas, a memória e o cartão abaixo são os do prompt real dela (llm_calls, 08/10 14:16 UTC).
 * O que estes testes prendem:
 *  - a data citada em texto (confirmação, lembrete, resumo) é reconhecida com a hora, mesmo na linha de baixo;
 *  - o que já passou (com a folga de 4 h da agenda) vira aviso explícito — no topo da conversa com a outra
 *    Sofia, depois do resumo e num bloco próprio lido do cartão;
 *  - dia/hora de consulta somem dos fatos da memória, e o nome da profissional some do prompt todo;
 *  - consulta FUTURA não ganha aviso nenhum (o prompt de quem marcou ontem para amanhã não muda).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LeadMemory, Unit } from '@prisma/client';

import {
  consultaPassouHaPouco,
  consultasQueJaPassaram,
  datasDeConsultaCitadas,
  rotuloDaConsulta,
} from './consulta-que-passou.js';
import { renderConversaComOutraSofia, type FalaDeOutraSofia } from './conversa-entre-sofias.js';
import { composeSystemPromptParts, fatoDeConsulta, renderEtapaLead, renderLeadMemory } from './prompt-composer.js';
import type { EstadoEtapaLead } from '../services/lead-stage.service.js';
import type { ConsultaReconciliada } from '../services/agenda-reconcile.service.js';

const CONFIRMACAO =
  '✅ Agendamento confirmado, João!\n\n⭐ Data: quarta-feira, 07/10/2026\n⏰ Horário: 13:00\n' +
  '⭐ Local: Rua São Raimundo, 375 — Centro, Açailândia/MA\n⏳ Chegue 15 minutos antes.\n✨ Valor: R$ 350 no dia\n' +
  '⭐ Atendimento com: a fisioterapeuta Aylana Silva Mendes\n\nQualquer dúvida, é só chamar. Até breve! 😊';
const VESPERA =
  'Oi, João! Passando para confirmar sua consulta de amanhã, quarta, 07/10 às 13:00 com fisioterapeuta Aylana Silva Mendes.\n' +
  '📍 Rua São Raimundo, 375 — Centro, Açailândia/MA\n\nResponda *1* para confirmar ou *2* se precisar remarcar. 😊';

const CONVERSA_DA_COMERCIAL: FalaDeOutraSofia[] = [
  { papel: 'paciente', texto: 'pagar na clinica', em: new Date('2026-10-06T13:16:47Z') },
  { papel: 'sofia', texto: CONFIRMACAO, em: new Date('2026-10-06T13:17:22Z') },
  { papel: 'sofia', texto: VESPERA, em: new Date('2026-10-06T13:43:33Z') },
  { papel: 'paciente', texto: '07/10/2026 13:00 O DIA', em: new Date('2026-10-06T14:41:13Z') },
  {
    papel: 'sofia',
    texto: 'Isso mesmo, João! Sua consulta está confirmada para quarta-feira, 07/10/2026, às 13h, com a fisioterapeuta Aylana 💙 Pode deixar que te espero lá!',
    em: new Date('2026-10-06T14:41:48Z'),
  },
  { papel: 'sofia', texto: 'Perfeito, João! Presença confirmada e pagamento na clínica 😊 Te espero quarta-feira, 07/10 às 13h! Até lá 💙', em: new Date('2026-10-06T17:15:44Z') },
];

const MEMORIA = {
  summary:
    'João de Deus está com dores na lombar há 6 meses, o que tem atrapalhado seu sono e seu dia a dia. Ele mora em Açailândia e tem consulta marcada para quarta-feira, 07/10/2026, às 13h. Ele prefere pagar na clínica, no valor de R$ 350.',
  facts: {
    cidade: 'Açailândia',
    queixa: 'Dor na lombar há 6 meses, atrapalhando muito o dia a dia',
    agendou: 'Sim',
    data_consulta: '07/10/2026',
    horario_consulta: '13h',
    preferencia_pagamento: 'na clínica',
  },
  lastSummarizedAt: new Date('2026-10-06T14:56:29Z'),
} as unknown as LeadMemory;

/** O cartão em PERDIDO, com o ◷ Data da Consulta de 07/10 13:00 (dentro da folga de 24 h do sinal "agendado"). */
const CARTAO: EstadoEtapaLead = { statusId: 143, nome: 'PERDIDO', jaAgendadoOuPaciente: true, consultaNoCartao: '2026-10-07T13:00' };

function resgate(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-resgate', slug: 'acailandia-resgate', name: 'Doutor Hérnia Açailândia', category: 'saude',
    systemPrompt: null, personaResponseLength: 'normal', personaLanguage: 'pt-BR', personaEmojis: [], handoffKeywords: [],
    pipelineIntents: null, spineEnabled: false, spineAgendaDays: [1, 2, 3, 4, 5],
    businessHoursTimezone: 'America/Sao_Paulo', spineTimezone: 'America/Sao_Paulo', sourceProdutos: null,
    ...over,
  } as unknown as Unit;
}

test('datas citadas: a confirmação traz a hora na linha de baixo; o lembrete, na mesma frase', () => {
  assert.deepEqual(datasDeConsultaCitadas(CONFIRMACAO, '2026-10-06'), ['2026-10-07T13:00']);
  assert.deepEqual(datasDeConsultaCitadas(VESPERA, '2026-10-06'), ['2026-10-07T13:00']);
  assert.deepEqual(datasDeConsultaCitadas('consulta quarta-feira, 07/10/2026, às 13h', '2026-10-06'), ['2026-10-07T13:00']);
  assert.deepEqual(datasDeConsultaCitadas('avaliação dia 09/10 às 7h30', '2026-10-06'), ['2026-10-09T07:30']);
});

test('datas citadas: só em texto que fala de consulta, e o ano vira quando precisa', () => {
  assert.deepEqual(datasDeConsultaCitadas('a dor começou 01/09, piorou 15/09', '2026-10-06'), [], 'sem falar de consulta não conta');
  assert.deepEqual(datasDeConsultaCitadas('consulta 05/01 às 9h30', '2026-12-20'), ['2027-01-05T09:30'], 'janeiro citado em dezembro é do ano que vem');
  assert.deepEqual(datasDeConsultaCitadas('consulta na sexta', '2026-10-06'), []);
  assert.deepEqual(datasDeConsultaCitadas('consulta 32/13', '2026-10-06'), [], 'data impossível não entra');
  assert.deepEqual(datasDeConsultaCitadas('consulta sexta, 09/10', '2026-10-06'), ['2026-10-09T23:59'], 'sem hora: o dia inteiro');
});

test('já passou: com a folga de 4 h, dentro de 30 dias, e o mesmo dia com e sem hora vira um só', () => {
  const textos = [{ texto: CONFIRMACAO, escritoEm: '2026-10-06' }, { texto: 'consulta quarta, 07/10', escritoEm: '2026-10-06' }];
  assert.deepEqual(consultasQueJaPassaram(textos, '2026-10-08T11:16'), ['2026-10-07T13:00']);
  assert.deepEqual(consultasQueJaPassaram(textos, '2026-10-07T16:30'), [], '3h30 depois: ele pode estar chegando — ainda é a de hoje');
  assert.deepEqual(consultasQueJaPassaram(textos, '2026-10-06T14:00'), [], 'véspera: é futura');
  assert.deepEqual(consultasQueJaPassaram(textos, '2026-12-01T10:00'), [], 'mais de 30 dias: não confunde mais ninguém');
  assert.equal(consultaPassouHaPouco('2026-10-07T13:00', '2026-10-08T11:16'), true);
  assert.equal(consultaPassouHaPouco(null, '2026-10-08T11:16'), false);
  assert.equal(rotuloDaConsulta('2026-10-07T13:00'), 'quarta-feira, 07/10/2026 às 13:00');
  assert.equal(rotuloDaConsulta('2026-10-09T23:59'), 'sexta-feira, 09/10/2026');
});

test('conversa com a outra Sofia: falas datadas, aviso de consulta que passou, sem o nome da profissional', () => {
  const b = renderConversaComOutraSofia(CONVERSA_DA_COMERCIAL, false, { agoraLocal: '2026-10-08T11:16', tz: 'America/Sao_Paulo' })!;
  assert.match(b, /CONSULTA QUE JÁ PASSOU: quarta-feira, 07\/10\/2026 às 13:00 — hoje é quinta-feira, 08\/10\/2026/);
  assert.match(b, /\(06\/10 10:43\) Sofia: Oi, João! Passando para confirmar sua consulta de amanhã/, 'o "amanhã" da véspera fica com o dia em que foi dito');
  assert.doesNotMatch(b, /Aylana/);
  assert.match(b, /Atendimento com: a fisioterapeuta Qualquer dúvida/);
  // antes da consulta, a mesma conversa não ganha aviso nenhum
  const naVespera = renderConversaComOutraSofia(CONVERSA_DA_COMERCIAL, false, { agoraLocal: '2026-10-06T15:00', tz: 'America/Sao_Paulo' })!;
  assert.doesNotMatch(naVespera, /JÁ PASSOU/);
});

test('memória: dia/hora de consulta saem dos fatos, o nome sai do resumo e a data velha ganha aviso', () => {
  const m = renderLeadMemory(MEMORIA, 'America/Sao_Paulo', '2026-10-08T11:16');
  assert.doesNotMatch(m, /data_consulta|horario_consulta/);
  assert.match(m, /agendou: Sim/);
  assert.match(m, /preferencia_pagamento: na clínica/);
  assert.match(m, /CONSULTA QUE JÁ PASSOU: quarta-feira, 07\/10\/2026 às 13:00/);
  // no dia em que foi escrita, a consulta é futura: só os fatos velhos saem
  assert.doesNotMatch(renderLeadMemory(MEMORIA, 'America/Sao_Paulo', '2026-10-06T15:00'), /JÁ PASSOU/);
  const comNome = renderLeadMemory({ ...MEMORIA, summary: 'Marcou avaliação com a fisioterapeuta Aylana Silva Mendes.' } as LeadMemory, 'America/Sao_Paulo');
  assert.doesNotMatch(comNome, /Aylana/);
});

test('fatos de consulta: só dia/hora/profissional — preferência de horário e "agendou" ficam', () => {
  for (const k of ['data_consulta', 'horario_consulta', 'dia_da_consulta', 'data_agendamento', 'hora_avaliacao', 'fisioterapeuta', 'profissional_consulta']) {
    assert.equal(fatoDeConsulta(k), true, k);
  }
  for (const k of ['agendou', 'preferencia_horario', 'dia_preferido', 'queixa', 'atrapalha_sono', 'intencao']) {
    assert.equal(fatoDeConsulta(k), false, k);
  }
});

test('etapa do lead: com a consulta do cartão já passada, não diz mais "ele já tem consulta marcada"', () => {
  const passou = renderEtapaLead(CARTAO, 'America/Sao_Paulo', '2026-10-08T11:16');
  assert.match(passou, /já teve consulta marcada nesta clínica \(a data já passou\)/);
  assert.doesNotMatch(passou, /ele já tem consulta marcada/);
  const futura = renderEtapaLead({ ...CARTAO, consultaNoCartao: '2026-10-09T13:00' }, 'America/Sao_Paulo', '2026-10-08T11:16');
  assert.match(futura, /ele já tem consulta marcada ou já é paciente/);
});

test('o prompt real da Sofia de resgate (08/10 11:16): consulta de ontem chega como passada e sem nome', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T14:16:36Z') });
  const { dynamic } = composeSystemPromptParts({
    unit: resgate(),
    leadId: 28088906,
    leadMemory: MEMORIA,
    estadoEtapa: CARTAO,
    outraSofia: CONVERSA_DA_COMERCIAL,
    userMessage: 'oi, teste',
  });
  assert.match(dynamic, /<consulta_que_ja_passou>/, 'o cartão é a fonte que a Sofia sem agenda lê');
  assert.match(dynamic, /◷ Data da Consulta/);
  assert.match(dynamic, /CONSULTA QUE JÁ PASSOU: quarta-feira, 07\/10\/2026 às 13:00 — hoje é quinta-feira, 08\/10\/2026/);
  assert.match(dynamic, /pergunte com naturalidade como foi a consulta ou se ele precisa remarcar/);
  assert.doesNotMatch(dynamic, /Aylana/, 'o nome da profissional não chega ao modelo');
  assert.doesNotMatch(dynamic, /data_consulta|horario_consulta/);
  assert.doesNotMatch(dynamic, /ele já tem consulta marcada/);
});

test('consulta FUTURA no cartão: nenhum aviso de "já passou" (o prompt da véspera não muda)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T18:00:00Z') }); // 06/10 15:00, véspera
  const { dynamic } = composeSystemPromptParts({
    unit: resgate(),
    leadId: 28088906,
    leadMemory: MEMORIA,
    estadoEtapa: CARTAO,
    outraSofia: CONVERSA_DA_COMERCIAL,
  });
  assert.doesNotMatch(dynamic, /JÁ PASSOU|consulta_que_ja_passou/);
  assert.match(dynamic, /ele já tem consulta marcada ou já é paciente/);
});

test('com a agenda viva no prompt, o bloco do cartão não se repete — e a consulta passada pede "como foi"', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T14:16:36Z') });
  const consulta: ConsultaReconciliada = {
    idSchedule: 3738045, quando: '2026-10-07T13:00', salvo: '2026-10-07T13:00', estado: 'confirmada', mudou: false,
    especialista: 'fisioterapeuta Aylana Silva Mendes',
  } as ConsultaReconciliada;
  const { dynamic } = composeSystemPromptParts({
    unit: resgate({ slug: 'doutor-hernia-acailandia', spineEnabled: true }),
    leadId: 28088906,
    consulta,
    estadoEtapa: CARTAO,
  });
  assert.match(dynamic, /<consulta_do_paciente>[\s\S]*JÁ PASSOU \(hoje é quinta-feira, 08\/10\/2026\)/);
  assert.match(dynamic, /pergunte com naturalidade como foi ou se ele precisa remarcar/);
  assert.doesNotMatch(dynamic, /<consulta_que_ja_passou>/);
  assert.doesNotMatch(dynamic, /Aylana/, 'consulta passada não carrega o nome de quem atenderia');
});
