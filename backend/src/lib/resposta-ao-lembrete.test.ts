import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  CAMPOS_DO_LEMBRETE,
  JANELA_LEMBRETE_S,
  TOLERANCIA_DEPOIS_S,
  classificarBotaoDoLembrete,
  datasDoCartao,
  escolherAgendamento,
  podeSerBotaoDoLembrete,
  qualLembrete,
  textoRespostaAoLembrete,
  tratarBotaoDoLembrete,
  type DepsLembrete,
  type KommoDoLembrete,
} from './resposta-ao-lembrete.js';
import { estadoDoLembrete, vesperaPeloRoboDoKommo } from './lembrete-chaves.js';
import { classificarRespostaD1 } from './confirmacao-d1.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import type { Simulacao } from './so-no-papel.js';

/**
 * Caso que motivou (Açailândia, auditoria de 16/10/2026): 104 mensagens de 20 pacientes em tratamento em 7 dias,
 * a maioria tocando "Confirmar presença" no lembrete da sessão, sem resposta nenhuma — e em AGENDADO a Sofia dizia
 * "presença confirmada" sem registrar na franquia. Decisão do João: responde sozinho e confirma na franquia.
 */

const SLUG = 'doutor-hernia-acailandia';
const TZ = 'America/Sao_Paulo';
const ENV_LIGADO = { CONFIRMACAO_D1_SLUGS: SLUG, CONFIRMAR_SESSAO_SLUGS: SLUG } as NodeJS.ProcessEnv;
// 16/10/2026 12:00 em Açailândia (UTC-3)
const AGORA = new Date('2026-10-16T15:00:00Z');
const AGORA_S = Math.floor(AGORA.getTime() / 1000);
// sessão de amanhã, 17/10 às 09:00 local
const SESSAO_S = Math.floor(Date.parse('2026-10-17T12:00:00Z') / 1000);
// consulta de amanhã, 17/10 às 14:30 local
const CONSULTA_S = Math.floor(Date.parse('2026-10-17T17:30:00Z') / 1000);

const unidade = (over: Partial<Unit> = {}): Unit =>
  ({
    id: 'u1',
    slug: SLUG,
    name: 'Açailândia',
    spineEnabled: true,
    spineToken: 'tok',
    spineTimezone: TZ,
    businessHoursTimezone: null,
    kommoSubdomain: 'doutorherniaacailandia',
    kommoAccessToken: 'x',
    ...over,
  }) as Unit;

function agendamento(over: Partial<SpineSchedule> & { utc: string }): SpineSchedule {
  const d = new Date(over.utc);
  const local = new Date(d.getTime() - 3 * 3600_000).toISOString();
  return {
    idSchedule: 9001,
    idTreatment: 555,
    idStatus: SPINE_STATUS.AGENDADO,
    statusName: 'Agendado',
    clientName: 'MARIA SILVA',
    categoryName: 'Sessão',
    physicalTherapist: null,
    dateAttendanceUtc: d.toISOString(),
    dateAttendanceLocal: local.slice(0, 19),
    dayLocal: local.slice(0, 10),
    timeLocal: local.slice(11, 16),
    isBusy: true,
    requiresManualValidation: false,
    ...over,
  };
}

const IDS: Record<string, number> = {
  [CAMPOS_DO_LEMBRETE.CONSULTA]: 1,
  [CAMPOS_DO_LEMBRETE.SESSAO]: 2,
  [CAMPOS_DO_LEMBRETE.ID_TRATAMENTO]: 3,
  [CAMPOS_DO_LEMBRETE.ID_CLIENTE]: 4,
};
const campoPorNome = (n: string): number | null => IDS[n] ?? null;

function cartao(campos: Partial<Record<1 | 2 | 3 | 4, number>>) {
  return {
    id: 777,
    name: 'MARIA SILVA',
    status_id: 10,
    pipeline_id: 20,
    custom_fields_values: Object.entries(campos).map(([id, v]) => ({ field_id: Number(id), values: [{ value: v }] })),
  };
}

function kommoFalso(lead: ReturnType<typeof cartao>) {
  const k = {
    leituras: 0,
    respostas: [] as string[],
    tarefas: [] as string[],
    situacao: [] as Array<{ fieldId: number; valor: unknown }>,
    cliente: {
      getLead: async () => {
        k.leituras++;
        return lead;
      },
      sendChatReply: async (p: { text: string }) => {
        k.respostas.push(p.text);
        return { via: 'salesbot' as const };
      },
      createTask: async (a: { text: string }) => {
        k.tarefas.push(a.text);
        return { id: 1 };
      },
      listLeadCustomFieldsTyped: async () => [
        { id: 99, name: '✓ Situação da consulta', type: 'select', code: null, enums: [{ id: 1, value: 'Agendado' }, { id: 2, value: 'Confirmado' }] },
      ],
      setLeadCustomFieldValue: async (_l: number, fieldId: number, _t: unknown, valor: unknown) => {
        k.situacao.push({ fieldId, valor });
      },
    } as unknown as KommoDoLembrete,
  };
  return k;
}

function depsFalsas(schedules: SpineSchedule[] | null) {
  const registro = { confirmados: [] as number[], tratados: new Set<string>(), simulados: [] as Simulacao[], buscas: 0 };
  const deps: DepsLembrete = {
    agora: () => AGORA,
    esquema: async () => ({ campoPorNome }),
    agendamentos: async () => {
      registro.buscas++;
      return schedules;
    },
    franquia: {
      confirmSchedule: async (_u, id) => {
        registro.confirmados.push(id);
        return { ok: true };
      },
      esquecerConsulta: () => undefined,
    },
    jaTratado: async (_u, _l, chave) => registro.tratados.has(chave),
    marcarTratado: async (_u, _l, chave) => {
      registro.tratados.add(chave);
    },
    simular: (_u, _a, s) => {
      registro.simulados.push(s);
    },
  };
  return { deps, registro };
}

beforeEach(() => _semearParaTeste([]));

// ── o toque ──────────────────────────────────────────────────────────────────────────────────────

test('botão: os rótulos dos modelos (com acento, emoji e caixa diferentes) são reconhecidos', () => {
  for (const t of ['Confirmar presença', 'CONFIRMAR PRESENÇA', 'confirmar presenca ✅', 'Confirmar', 'Confirmo', ' Confirmar presença. ']) {
    assert.equal(classificarBotaoDoLembrete(t), 'confirmou', t);
  }
  for (const t of ['Preciso remarcar', 'Quero remarcar', 'preciso reagendar', 'Remarcar']) {
    assert.equal(classificarBotaoDoLembrete(t), 'remarcar', t);
  }
});

test('botão: resposta solta ou com conversa junto NÃO é toque — fica com a Sofia', () => {
  for (const t of ['1', 'sim', 'ok', 'Confirmar, mas posso chegar 14h?', 'qual o endereço?', '', 'não vou poder']) {
    assert.equal(classificarBotaoDoLembrete(t), null, t);
  }
});

test('véspera por TEXTO continua no caminho do servidor ("1" / "2") e o botão do servidor também', () => {
  // A pergunta que o servidor manda ("responda 1 ou 2" / botões Confirmo · Preciso remarcar) segue em confirmacao-d1.
  assert.equal(classificarRespostaD1('1'), 'confirmou');
  assert.equal(classificarRespostaD1('2'), 'remarcar');
  assert.equal(classificarRespostaD1('Confirmo'), 'confirmou');
  // ...e o rótulo do botão do Kommo também é entendido por lá, se a pergunta do servidor estiver armada.
  assert.equal(classificarRespostaD1('Confirmar presença'), 'confirmou');
  assert.equal(classificarRespostaD1('Preciso remarcar'), 'remarcar');
});

test('chaves: desligado não responde 200 antes nem trata; seco ou ligado sim', () => {
  assert.equal(podeSerBotaoDoLembrete(SLUG, 'Confirmar presença', {} as NodeJS.ProcessEnv), false);
  assert.equal(podeSerBotaoDoLembrete(SLUG, 'Confirmar presença', ENV_LIGADO), true);
  assert.equal(podeSerBotaoDoLembrete(SLUG, 'quanto custa?', ENV_LIGADO), false);
  _semearParaTeste([{ slug: SLUG, automacao: 'confirmar-sessao', estado: 'seco' }]);
  assert.equal(podeSerBotaoDoLembrete(SLUG, 'Confirmar presença', {} as NodeJS.ProcessEnv), true);
});

test('chave confirmacao-d1: só LIGADA tira a véspera do servidor; só no papel não muda nada', () => {
  assert.equal(vesperaPeloRoboDoKommo(SLUG, {} as NodeJS.ProcessEnv), false);
  assert.equal(vesperaPeloRoboDoKommo(SLUG, { CONFIRMACAO_D1_SLUGS: SLUG } as NodeJS.ProcessEnv), true);
  assert.equal(vesperaPeloRoboDoKommo('doutor-hernia-serra', { CONFIRMACAO_D1_SLUGS: SLUG } as NodeJS.ProcessEnv), false);
  _semearParaTeste([{ slug: SLUG, automacao: 'confirmacao-d1', estado: 'seco' }]);
  assert.equal(estadoDoLembrete(SLUG, 'consulta', {} as NodeJS.ProcessEnv), 'seco');
  assert.equal(vesperaPeloRoboDoKommo(SLUG, {} as NodeJS.ProcessEnv), false);
});

// ── a qual lembrete ──────────────────────────────────────────────────────────────────────────────

test('qualLembrete: só o que está nas próximas 30 h (ou passou há menos de 30 min) e com chave', () => {
  const ligados = { consulta: 'ligado', sessao: 'ligado' } as const;
  assert.equal(qualLembrete({ datas: { consulta: null, sessao: SESSAO_S }, agoraEpoch: AGORA_S, estados: ligados })?.tipo, 'sessao');
  assert.equal(qualLembrete({ datas: { consulta: null, sessao: AGORA_S + JANELA_LEMBRETE_S + 60 }, agoraEpoch: AGORA_S, estados: ligados }), null);
  assert.equal(qualLembrete({ datas: { consulta: null, sessao: AGORA_S - TOLERANCIA_DEPOIS_S - 60 }, agoraEpoch: AGORA_S, estados: ligados }), null);
  assert.equal(
    qualLembrete({ datas: { consulta: null, sessao: SESSAO_S }, agoraEpoch: AGORA_S, estados: { consulta: 'ligado', sessao: 'desligado' } }),
    null,
  );
  // as duas valendo: a mais próxima (o último lembrete que saiu)
  const ambos = qualLembrete({ datas: { consulta: CONSULTA_S, sessao: SESSAO_S }, agoraEpoch: AGORA_S, estados: ligados });
  assert.equal(ambos?.tipo, 'sessao');
});

test('datasDoCartao: lê as datas e os ids pelos nomes dos campos', () => {
  const d = datasDoCartao(cartao({ 1: CONSULTA_S, 2: SESSAO_S, 3: 555, 4: 321 }), campoPorNome);
  assert.deepEqual(d, { consulta: CONSULTA_S, sessao: SESSAO_S, idTreatment: 555, idClient: 321 });
  assert.deepEqual(datasDoCartao(cartao({}), campoPorNome), { consulta: null, sessao: null, idTreatment: null, idClient: null });
});

// ── qual agendamento ─────────────────────────────────────────────────────────────────────────────

test('escolherAgendamento: o do MESMO horário do cartão, do tipo certo e de pé', () => {
  const sessao = agendamento({ utc: '2026-10-17T12:00:00Z' });
  const outraSessao = agendamento({ utc: '2026-10-20T12:00:00Z', idSchedule: 9002 });
  const avaliacao = agendamento({ utc: '2026-10-17T12:00:00Z', idSchedule: 9003, categoryName: 'Avaliação', idTreatment: null });
  const desmarcada = agendamento({ utc: '2026-10-17T12:00:00Z', idSchedule: 9004, idStatus: SPINE_STATUS.DESMARCADO });
  const deOutroTratamento = agendamento({ utc: '2026-10-17T12:00:00Z', idSchedule: 9005, idTreatment: 999 });
  const todas = [outraSessao, avaliacao, desmarcada, deOutroTratamento, sessao];
  assert.equal(escolherAgendamento({ schedules: todas, tipo: 'sessao', quandoEpoch: SESSAO_S, idTreatment: 555, tz: TZ })?.idSchedule, 9001);
  assert.equal(escolherAgendamento({ schedules: todas, tipo: 'consulta', quandoEpoch: SESSAO_S, idTreatment: null, tz: TZ })?.idSchedule, 9003);
});

test('escolherAgendamento: horário que não bate, ou dois no mesmo horário → não confirma no escuro', () => {
  const sessao = agendamento({ utc: '2026-10-17T13:00:00Z' }); // uma hora depois do cartão
  assert.equal(escolherAgendamento({ schedules: [sessao], tipo: 'sessao', quandoEpoch: SESSAO_S, idTreatment: 555, tz: TZ }), null);
  const a = agendamento({ utc: '2026-10-17T12:00:00Z', idTreatment: null });
  const b = agendamento({ utc: '2026-10-17T12:00:00Z', idSchedule: 9010, idTreatment: null });
  assert.equal(escolherAgendamento({ schedules: [a, b], tipo: 'sessao', quandoEpoch: SESSAO_S, idTreatment: 555, tz: TZ }), null);
});

test('escolherAgendamento: campo só com o dia (meia-noite) aceita o ÚNICO daquele dia', () => {
  const meiaNoiteLocal = Math.floor(Date.parse('2026-10-17T03:00:00Z') / 1000);
  const sessao = agendamento({ utc: '2026-10-17T12:00:00Z' });
  assert.equal(escolherAgendamento({ schedules: [sessao], tipo: 'sessao', quandoEpoch: meiaNoiteLocal, idTreatment: 555, tz: TZ })?.idSchedule, 9001);
  const outra = agendamento({ utc: '2026-10-17T18:00:00Z', idSchedule: 9011 });
  assert.equal(escolherAgendamento({ schedules: [sessao, outra], tipo: 'sessao', quandoEpoch: meiaNoiteLocal, idTreatment: 555, tz: TZ }), null);
});

test('textos: sessão e consulta com dia da semana e hora; remarcar sem prometer horário', () => {
  assert.equal(
    textoRespostaAoLembrete({ tipo: 'sessao', resposta: 'confirmou', nome: 'Maria Silva', quando: '2026-10-17T09:00' }),
    'Presença confirmada, Maria! 💙 Te esperamos na sua sessão sábado, 17/10 às 09:00. Qualquer coisa é só me chamar por aqui.',
  );
  assert.match(textoRespostaAoLembrete({ tipo: 'consulta', resposta: 'confirmou', nome: null, quando: '2026-10-17T14:30' }), /^Confirmado! 💙 Te esperamos sábado, 17\/10 às 14:30\./);
  assert.match(textoRespostaAoLembrete({ tipo: 'consulta', resposta: 'remarcar', nome: 'Ana', quando: null }), /^Sem problema, Ana! 🙏/);
});

// ── de ponta a ponta (Kommo e franquia falsos) ───────────────────────────────────────────────────

test('SESSÃO: toque em "Confirmar presença" → responde e CONFIRMA na franquia o agendamento certo', async () => {
  const k = kommoFalso(cartao({ 2: SESSAO_S, 3: 555 }));
  const { deps, registro } = depsFalsas([agendamento({ utc: '2026-10-17T12:00:00Z' })]);
  const r = await tratarBotaoDoLembrete(
    { unit: unidade(), leadId: 777, texto: 'Confirmar presença', conv: { contactName: 'Maria Silva', phone: null }, kommo: k.cliente, env: ENV_LIGADO },
    deps,
  );
  assert.deepEqual(r, { resposta: 'confirmou', tipo: 'sessao', idSchedule: 9001, franquia: 'confirmada' });
  assert.deepEqual(registro.confirmados, [9001], 'PATCH /api/schedules/confirm com o id da sessão');
  assert.equal(k.respostas.length, 1);
  assert.match(k.respostas[0], /^Presença confirmada, Maria! 💙 Te esperamos na sua sessão sábado, 17\/10 às 09:00/);
  assert.equal(k.tarefas.length, 0, 'deu certo: ninguém precisa agir');
  assert.equal(k.situacao.length, 0, 'sessão não mexe na Situação da CONSULTA');
});

test('VÉSPERA (consulta): toque no botão do modelo do Kommo → responde, marca Confirmado e confirma na franquia', async () => {
  const k = kommoFalso(cartao({ 1: CONSULTA_S, 4: 321 }));
  const consulta = agendamento({ utc: '2026-10-17T17:30:00Z', idSchedule: 3738045, categoryName: 'Avaliação', idTreatment: null });
  const { deps, registro } = depsFalsas([consulta]);
  const r = await tratarBotaoDoLembrete(
    { unit: unidade(), leadId: 777, texto: 'Confirmar presença', conv: { contactName: 'João', phone: null }, kommo: k.cliente, env: ENV_LIGADO },
    deps,
  );
  assert.equal(r?.tipo, 'consulta');
  assert.equal(r?.franquia, 'confirmada');
  assert.deepEqual(registro.confirmados, [3738045]);
  assert.match(k.respostas[0], /^Confirmado, João! 💙 Te esperamos sábado, 17\/10 às 14:30\. Chegue uns 15 minutos antes/);
  assert.deepEqual(k.situacao, [{ fieldId: 99, valor: 'Confirmado' }]);
});

test('"Preciso remarcar" → tarefa para a equipe + resposta; NADA na franquia', async () => {
  const k = kommoFalso(cartao({ 2: SESSAO_S, 3: 555 }));
  const { deps, registro } = depsFalsas([agendamento({ utc: '2026-10-17T12:00:00Z' })]);
  const r = await tratarBotaoDoLembrete(
    { unit: unidade(), leadId: 777, texto: 'Preciso remarcar', conv: { contactName: 'Maria', phone: null }, kommo: k.cliente, env: ENV_LIGADO },
    deps,
  );
  assert.equal(r?.resposta, 'remarcar');
  assert.equal(r?.franquia, null);
  assert.deepEqual(registro.confirmados, []);
  assert.equal(k.tarefas.length, 1);
  assert.match(k.tarefas[0], /🔁 Pediu para remarcar a sessão de sábado, 17\/10 às 09:00/);
  assert.match(k.respostas[0], /^Sem problema, Maria! 🙏/);
});

test('idempotência: o mesmo toque de novo (reentrega ou dois toques) não responde nem confirma outra vez', async () => {
  const k = kommoFalso(cartao({ 2: SESSAO_S, 3: 555 }));
  const { deps, registro } = depsFalsas([agendamento({ utc: '2026-10-17T12:00:00Z' })]);
  const args = { unit: unidade(), leadId: 777, texto: 'Confirmar presença', conv: { contactName: 'Maria', phone: null }, kommo: k.cliente, env: ENV_LIGADO };
  await tratarBotaoDoLembrete(args, deps);
  const segunda = await tratarBotaoDoLembrete(args, deps);
  assert.equal(segunda?.resposta, 'repetida', 'tratado em código: também não vai para a Sofia');
  assert.equal(k.respostas.length, 1);
  assert.deepEqual(registro.confirmados, [9001]);
});

test('dois toques quase juntos (duplo clique): uma resposta e uma confirmação só', async () => {
  const k = kommoFalso(cartao({ 2: SESSAO_S, 3: 555 }));
  const { deps, registro } = depsFalsas([agendamento({ utc: '2026-10-17T12:00:00Z' })]);
  const args = { unit: unidade(), leadId: 777, texto: 'Confirmar presença', conv: { contactName: 'Maria', phone: null }, kommo: k.cliente, env: ENV_LIGADO };
  const [a, b] = await Promise.all([tratarBotaoDoLembrete(args, deps), tratarBotaoDoLembrete(args, deps)]);
  assert.deepEqual([a?.resposta, b?.resposta].sort(), ['confirmou', 'repetida']);
  assert.equal(k.respostas.length, 1);
  assert.deepEqual(registro.confirmados, [9001]);
});

test('agendamento não bate com o horário do cartão → responde, NÃO confirma, e abre tarefa para a equipe', async () => {
  const k = kommoFalso(cartao({ 2: SESSAO_S, 3: 555 }));
  const { deps, registro } = depsFalsas([agendamento({ utc: '2026-10-17T15:00:00Z' })]);
  const r = await tratarBotaoDoLembrete(
    { unit: unidade(), leadId: 777, texto: 'Confirmar presença', conv: { contactName: 'Maria', phone: null }, kommo: k.cliente, env: ENV_LIGADO },
    deps,
  );
  assert.equal(r?.franquia, 'sem_consulta');
  assert.deepEqual(registro.confirmados, []);
  assert.equal(k.respostas.length, 1);
  assert.equal(k.tarefas.length, 1);
  assert.match(k.tarefas[0], /CONFIRMOU pelo WhatsApp a sessão.*sem sessão/);
});

test('só no papel: não responde nem escreve — registra na tela o que faria e deixa a Sofia seguir', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'confirmar-sessao', estado: 'seco' }]);
  const k = kommoFalso(cartao({ 2: SESSAO_S, 3: 555 }));
  const { deps, registro } = depsFalsas([agendamento({ utc: '2026-10-17T12:00:00Z' })]);
  const r = await tratarBotaoDoLembrete(
    { unit: unidade(), leadId: 777, texto: 'Confirmar presença', conv: { contactName: 'Maria', phone: null }, kommo: k.cliente, env: {} as NodeJS.ProcessEnv },
    deps,
  );
  assert.equal(r, null);
  assert.equal(k.respostas.length, 0);
  assert.equal(k.tarefas.length, 0);
  assert.deepEqual(registro.confirmados, []);
  assert.equal(registro.simulados.length, 1);
  assert.equal(registro.simulados[0].acao, 'gravaria');
  assert.match(String(registro.simulados[0].motivo), /agendamento 9001/);
});

test('chaves desligadas: nem lê o cartão', async () => {
  const k = kommoFalso(cartao({ 2: SESSAO_S }));
  const { deps } = depsFalsas([]);
  const r = await tratarBotaoDoLembrete(
    { unit: unidade(), leadId: 777, texto: 'Confirmar presença', conv: { contactName: null, phone: null }, kommo: k.cliente, env: {} as NodeJS.ProcessEnv },
    deps,
  );
  assert.equal(r, null);
  assert.equal(k.leituras, 0);
});

test('sem lembrete nas próximas 30 h (toque antigo): segue para a Sofia, sem resposta em código', async () => {
  const k = kommoFalso(cartao({ 2: SESSAO_S + 5 * 86_400, 3: 555 }));
  const { deps, registro } = depsFalsas([]);
  const r = await tratarBotaoDoLembrete(
    { unit: unidade(), leadId: 777, texto: 'Confirmar presença', conv: { contactName: null, phone: null }, kommo: k.cliente, env: ENV_LIGADO },
    deps,
  );
  assert.equal(r, null);
  assert.equal(registro.buscas, 0);
  assert.equal(k.respostas.length, 0);
});

test('franquia fora do ar: responde, não confirma e avisa a equipe (o "não sei" nunca vira "confirmado")', async () => {
  const k = kommoFalso(cartao({ 2: SESSAO_S, 3: 555 }));
  const { deps, registro } = depsFalsas(null);
  const r = await tratarBotaoDoLembrete(
    { unit: unidade(), leadId: 777, texto: 'Confirmar', conv: { contactName: 'Maria', phone: null }, kommo: k.cliente, env: ENV_LIGADO },
    deps,
  );
  assert.equal(r?.franquia, 'sem_consulta');
  assert.deepEqual(registro.confirmados, []);
  assert.equal(k.tarefas.length, 1);
  // o horário dito é o do cartão (o que o lembrete mostrou)
  assert.match(k.respostas[0], /sábado, 17\/10 às 09:00/);
});
