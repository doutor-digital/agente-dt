import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  CAMPOS_DO_LEMBRETE,
  JANELA_LEMBRETE_S,
  alvoDoLembrete,
  classificarBotaoDoLembrete,
  datasDoCartao,
  escolherAgendamento,
  horaDaMensagem,
  lembreteDaMensagem,
  lerChaveDoToque,
  podeSerBotaoDoLembrete,
  provaDoLembrete,
  textoRespostaAoLembrete,
  tratarBotaoDoLembrete,
  type DepsLembrete,
  type KommoDoLembrete,
  type ProvaDoLembrete,
} from './resposta-ao-lembrete.js';
import { estadoDoLembrete, vesperaDoServidorDesligada } from './lembrete-chaves.js';
import { classificarRespostaD1 } from './confirmacao-d1.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
import type { Simulacao } from './so-no-papel.js';

/**
 * Caso que motivou (Açailândia, auditoria de 16/10/2026): 104 mensagens de 20 pacientes em tratamento em 7 dias,
 * a maioria tocando "Confirmar presença" no lembrete da sessão, sem resposta nenhuma — e em AGENDADO a Sofia dizia
 * "presença confirmada" sem registrar na franquia. Decisão do João: responde sozinho e confirma na franquia.
 *
 * Revisão de 16/10 (itens 1 e 2): quem diz de qual agendamento o paciente fala é a ÚLTIMA fala que saiu na conversa
 * — o lembrete do robô. Sem ela (a SDR ou a Sofia falou por último), o toque não é com este tratamento.
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

const VESPERA_SESSAO = 'Olá, Maria! A sua sessão é amanhã, 17/10, às 09:00. Confirma a sua presença?';
const VESPERA_CONSULTA = 'Olá! Passando para lembrar da sua consulta amanhã, 17/10, às 14:30. Está tudo certo?';

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

const saida = (texto: string, em: Date, autor: MensagemOficial['autor'] = 'sofia', id = `s-${em.getTime()}`): MensagemOficial => ({
  id,
  em,
  direcao: 'saida',
  autor,
  autorNome: '',
  texto,
  anexo: null,
  status: null,
});
const entrada = (texto: string, em: Date): MensagemOficial => ({
  id: `e-${em.getTime()}`,
  em,
  direcao: 'entrada',
  autor: 'paciente',
  autorNome: '',
  texto,
  anexo: null,
  status: null,
});
const horasAntes = (h: number, base = AGORA) => new Date(base.getTime() - h * 3600_000);

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

/**
 * Kommo e franquia falsos. A resposta que sai (`sendChatReply`) entra na conversa oficial como fala de saída,
 * como no Kommo de verdade — é isso que faz o segundo toque ser reconhecido como repetição.
 */
function cenario(opts: { lead: ReturnType<typeof cartao>; conversa: MensagemOficial[] | null; schedules: SpineSchedule[] | null; falasDaSofia?: string[]; agora?: Date }) {
  const agora = opts.agora ?? AGORA;
  const conversa = opts.conversa ? [...opts.conversa] : null;
  const r = {
    leituras: 0,
    respostas: [] as string[],
    tarefas: [] as string[],
    situacao: [] as Array<{ fieldId: number; valor: unknown }>,
    confirmados: [] as number[],
    marcas: new Map<string, Date>(),
    simulados: [] as Simulacao[],
    gravadas: [] as string[],
    buscas: 0,
  };
  const kommo = {
    getLead: async () => {
      r.leituras++;
      return opts.lead;
    },
    sendChatReply: async (p: { text: string }) => {
      r.respostas.push(p.text);
      conversa?.push(saida(p.text, new Date(agora.getTime() + r.respostas.length * 10_000)));
      return { via: 'salesbot' as const };
    },
    createTask: async (a: { text: string }) => {
      r.tarefas.push(a.text);
      return { id: 1 };
    },
    listLeadCustomFieldsTyped: async () => [
      { id: 99, name: '✓ Situação da consulta', type: 'select', code: null, enums: [{ id: 1, value: 'Agendado' }, { id: 2, value: 'Confirmado' }] },
    ],
    setLeadCustomFieldValue: async (_l: number, fieldId: number, _t: unknown, valor: unknown) => {
      r.situacao.push({ fieldId, valor });
    },
  } as unknown as KommoDoLembrete;
  const deps: DepsLembrete = {
    agora: () => agora,
    esquema: async () => ({ campoPorNome }),
    oficiais: async () => (conversa ? [...conversa] : null),
    // o que a Sofia disse + as respostas que este tratamento gravou no histórico
    falasDaSofia: async () => [...(opts.falasDaSofia ?? []), ...r.gravadas],
    agendamentos: async () => {
      r.buscas++;
      return opts.schedules;
    },
    franquia: {
      confirmSchedule: async (_u, id) => {
        r.confirmados.push(id);
        return { ok: true };
      },
      esquecerConsulta: () => undefined,
    },
    jaTratado: async (_u, _l, chave) => r.marcas.has(chave),
    ultimoTratado: async () => {
      const ultimas = [...r.marcas.entries()].sort((a, b) => b[1].getTime() - a[1].getTime());
      return ultimas.length ? lerChaveDoToque(ultimas[0][0], ultimas[0][1]) : null;
    },
    marcarTratado: async (_u, _l, chave) => {
      r.marcas.set(chave, agora);
    },
    registrarResposta: async (_c, texto) => {
      r.gravadas.push(texto);
    },
    simular: (_u, _a, s) => {
      r.simulados.push(s);
    },
  };
  const tocar = (texto: string, env: NodeJS.ProcessEnv = ENV_LIGADO) =>
    tratarBotaoDoLembrete({ unit: unidade(), leadId: 777, texto, conv: { id: 'c1', contactName: 'Maria Silva', phone: null }, kommo, env }, deps);
  return { r, deps, tocar };
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
  assert.equal(classificarRespostaD1('1'), 'confirmou');
  assert.equal(classificarRespostaD1('2'), 'remarcar');
  assert.equal(classificarRespostaD1('Confirmo'), 'confirmou');
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

test('item 5 — chave confirmacao-d1 fora de "desligado" (seco OU ligado) tira a véspera do servidor: nunca duas vésperas', () => {
  assert.equal(vesperaDoServidorDesligada(SLUG, {} as NodeJS.ProcessEnv), false);
  assert.equal(vesperaDoServidorDesligada(SLUG, { CONFIRMACAO_D1_SLUGS: SLUG } as NodeJS.ProcessEnv), true);
  assert.equal(vesperaDoServidorDesligada('doutor-hernia-serra', { CONFIRMACAO_D1_SLUGS: SLUG } as NodeJS.ProcessEnv), false);
  _semearParaTeste([{ slug: SLUG, automacao: 'confirmacao-d1', estado: 'seco' }]);
  assert.equal(estadoDoLembrete(SLUG, 'consulta', {} as NodeJS.ProcessEnv), 'seco');
  // Antes da revisão o "só no papel" deixava a do servidor sair junto com a do robô do Kommo.
  assert.equal(vesperaDoServidorDesligada(SLUG, {} as NodeJS.ProcessEnv), true);
});

// ── a prova ──────────────────────────────────────────────────────────────────────────────────────

test('lembreteDaMensagem / horaDaMensagem: o tipo e a hora vêm do texto do modelo', () => {
  assert.equal(lembreteDaMensagem(VESPERA_SESSAO), 'sessao');
  assert.equal(lembreteDaMensagem(VESPERA_CONSULTA), 'consulta');
  assert.equal(lembreteDaMensagem('Sua consulta de retorno é amanhã às 10h'), 'consulta');
  assert.equal(lembreteDaMensagem('Lembrete: amanhã você tem consulta e sessão'), 'incerto');
  assert.equal(lembreteDaMensagem('Tudo certo para amanhã?'), 'incerto');
  assert.equal(lembreteDaMensagem('Qual o melhor horário para você?'), null);
  assert.equal(horaDaMensagem(VESPERA_SESSAO), '09:00');
  assert.equal(horaDaMensagem('às 9h, tá?'), '09:00');
  assert.equal(horaDaMensagem('às 14h30'), '14:30');
  assert.equal(horaDaMensagem('entre 9h e 10h'), null, 'duas horas diferentes: não dá para conferir');
  assert.equal(horaDaMensagem('sem hora'), null);
});

test('provaDoLembrete: SDR ou Sofia falando por último, ou lembrete velho, NÃO é prova', () => {
  const tap = entrada('Confirmado', horasAntes(0.01));
  assert.equal(provaDoLembrete({ msgs: [saida(VESPERA_SESSAO, horasAntes(2)), tap], agora: AGORA, falasDaSofia: [] })?.tipo, 'sessao');
  // a SDR perguntou outra coisa depois do lembrete
  const sdr = saida('Posso passar sua sessão para quinta às 15h? Confirma pra mim', horasAntes(1), 'equipe');
  assert.equal(provaDoLembrete({ msgs: [saida(VESPERA_SESSAO, horasAntes(2)), sdr, tap], agora: AGORA, falasDaSofia: [] }), null);
  // a Sofia falou por último (a fala está no nosso banco)
  const sofia = 'Sua consulta ficou para amanhã às 10h, posso confirmar?';
  assert.equal(provaDoLembrete({ msgs: [saida(sofia, horasAntes(1)), tap], agora: AGORA, falasDaSofia: [sofia] }), null);
  // lembrete de mais de 30 h
  assert.equal(provaDoLembrete({ msgs: [saida(VESPERA_SESSAO, horasAntes(JANELA_LEMBRETE_S / 3600 + 1)), tap], agora: AGORA, falasDaSofia: [] }), null);
  // conversa sem saída
  assert.equal(provaDoLembrete({ msgs: [tap], agora: AGORA, falasDaSofia: [] }), null);
});

test('alvoDoLembrete: o tipo do lembrete manda; data do cartão faltando ou fora da janela vira "incerto"', () => {
  const prova = (tipo: ProvaDoLembrete['tipo']): ProvaDoLembrete => ({ tipo, hora: null, mensagemId: 'm', em: horasAntes(1) });
  const ligados = { consulta: 'ligado', sessao: 'ligado' } as const;
  const datas = { consulta: CONSULTA_S, sessao: SESSAO_S };
  assert.deepEqual(alvoDoLembrete({ prova: prova('consulta'), datas, agoraEpoch: AGORA_S, estados: ligados }), {
    tipo: 'consulta',
    quandoEpoch: CONSULTA_S,
    estado: 'ligado',
    hora: null,
  });
  assert.equal(alvoDoLembrete({ prova: prova('sessao'), datas: { consulta: null, sessao: null }, agoraEpoch: AGORA_S, estados: ligados })?.tipo, 'incerto');
  assert.equal(alvoDoLembrete({ prova: prova('incerto'), datas, agoraEpoch: AGORA_S, estados: ligados })?.tipo, 'incerto');
  assert.equal(alvoDoLembrete({ prova: prova('sessao'), datas, agoraEpoch: AGORA_S, estados: { consulta: 'ligado', sessao: 'desligado' } }), null);
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
  const sessao = agendamento({ utc: '2026-10-17T13:00:00Z' });
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

test('SESSÃO: toque no lembrete da sessão → responde e CONFIRMA na franquia o agendamento certo', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  const r = await c.tocar('Confirmar presença');
  assert.deepEqual(r, { resposta: 'confirmou', tipo: 'sessao', idSchedule: 9001, franquia: 'confirmada' });
  assert.deepEqual(c.r.confirmados, [9001], 'PATCH /api/schedules/confirm com o id da sessão');
  assert.equal(c.r.respostas.length, 1);
  assert.match(c.r.respostas[0], /^Presença confirmada, Maria! 💙 Te esperamos na sua sessão sábado, 17\/10 às 09:00/);
  assert.equal(c.r.tarefas.length, 0);
  assert.equal(c.r.situacao.length, 0, 'sessão não mexe na Situação da CONSULTA');
  assert.deepEqual(c.r.gravadas, [c.r.respostas[0]], 'a resposta fica no histórico');
});

test('VÉSPERA (consulta): toque no botão do modelo → responde, marca Confirmado e confirma na franquia', async () => {
  const consulta = agendamento({ utc: '2026-10-17T17:30:00Z', idSchedule: 3738045, categoryName: 'Avaliação', idTreatment: null });
  const c = cenario({
    lead: cartao({ 1: CONSULTA_S, 4: 321 }),
    conversa: [saida(VESPERA_CONSULTA, horasAntes(1)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [consulta],
  });
  const r = await c.tocar('Confirmar presença');
  assert.equal(r?.tipo, 'consulta');
  assert.equal(r?.franquia, 'confirmada');
  assert.deepEqual(c.r.confirmados, [3738045]);
  assert.match(c.r.respostas[0], /^Confirmado, Maria! 💙 Te esperamos sábado, 17\/10 às 14:30\. Chegue uns 15 minutos antes/);
  assert.deepEqual(c.r.situacao, [{ fieldId: 99, valor: 'Confirmado' }]);
});

test('item 1 — retorno amanhã às 10h e sessão hoje às 18h: o toque na véspera do RETORNO confirma o retorno, não a sessão', async () => {
  // 16/10 10:05 local. A véspera do retorno (17/10 10:00) saiu às 10:00; a sessão de hoje é às 18:00.
  const agora = new Date('2026-10-16T13:05:00Z');
  const retornoS = Math.floor(Date.parse('2026-10-17T13:00:00Z') / 1000);
  const sessaoHojeS = Math.floor(Date.parse('2026-10-16T21:00:00Z') / 1000);
  const retorno = agendamento({ utc: '2026-10-17T13:00:00Z', idSchedule: 7001, categoryName: 'Retorno', idTreatment: null });
  const sessaoHoje = agendamento({ utc: '2026-10-16T21:00:00Z', idSchedule: 7002 });
  const c = cenario({
    agora,
    lead: cartao({ 1: retornoS, 2: sessaoHojeS, 3: 555 }),
    conversa: [saida('Olá! Sua consulta de retorno é amanhã, 17/10, às 10:00. Confirma?', horasAntes(1 / 12, agora)), entrada('Confirmar presença', agora)],
    schedules: [retorno, sessaoHoje],
  });
  const r = await c.tocar('Confirmar presença');
  // Antes da revisão: a data mais próxima (a sessão das 18h) vencia e a sessão era confirmada.
  assert.equal(r?.tipo, 'consulta');
  assert.deepEqual(c.r.confirmados, [7001]);
});

test('item 1 — lembrete que não diz se é consulta ou sessão: responde e abre tarefa, NADA na franquia', async () => {
  const c = cenario({
    lead: cartao({ 1: CONSULTA_S, 2: SESSAO_S, 3: 555 }),
    conversa: [saida('Olá! Tudo certo para amanhã? Confirme a sua presença.', horasAntes(1)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  const r = await c.tocar('Confirmar presença');
  assert.equal(r?.tipo, 'incerto');
  assert.deepEqual(c.r.confirmados, []);
  assert.equal(c.r.situacao.length, 0);
  assert.equal(c.r.respostas.length, 1);
  assert.match(c.r.respostas[0], /^Recebi sua confirmação, Maria! 💙/);
  assert.equal(c.r.tarefas.length, 1);
  assert.match(c.r.tarefas[0], /não deu para saber com certeza de qual agendamento.*Nada foi registrado na franquia/);
});

test('item 1 — a hora escrita no lembrete não é a da agenda: não confirma, responde e abre tarefa', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida('A sua sessão é amanhã, 17/10, às 11:00.', horasAntes(2)), entrada('Confirmar', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })], // 09:00 na agenda
  });
  const r = await c.tocar('Confirmar');
  assert.equal(r?.tipo, 'incerto');
  assert.match(String(r?.motivo), /diz 11:00 e a agenda diz 09:00/);
  assert.deepEqual(c.r.confirmados, []);
  assert.equal(c.r.tarefas.length, 1);
});

test('item 2 — "Confirmado" digitado respondendo outra pergunta da SDR: NÃO confirma o horário antigo, segue para a Sofia', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [
      saida(VESPERA_SESSAO, horasAntes(3)),
      entrada('Posso mudar para quinta?', horasAntes(2)),
      saida('Consigo quinta às 15h, confirma?', horasAntes(1), 'equipe'),
      entrada('Confirmado', horasAntes(0.01)),
    ],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  const r = await c.tocar('Confirmado');
  // Antes da revisão: confirmava a sessão antiga de amanhã 09:00 e calava a Sofia.
  assert.equal(r, null);
  assert.deepEqual(c.r.confirmados, []);
  assert.equal(c.r.respostas.length, 0);
  assert.equal(c.r.leituras, 0, 'nem chega a ler o cartão');
});

test('item 2 — a Sofia falou por último (fala gravada no nosso banco): não é resposta a lembrete', async () => {
  const fala = 'Sua sessão de amanhã está mantida às 09:00, quer que eu confirme?';
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(3)), entrada('ainda tá de pé?', horasAntes(2)), saida(fala, horasAntes(1)), entrada('Confirmado', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
    falasDaSofia: [fala],
  });
  assert.equal(await c.tocar('Confirmado'), null);
  assert.deepEqual(c.r.confirmados, []);
});

test('item 2 — repetição do toque NUNCA fica sem resposta: "Já está confirmado ✅", sem confirmar de novo', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  await c.tocar('Confirmar presença');
  const segunda = await c.tocar('Confirmar presença');
  assert.equal(segunda?.resposta, 'repetida');
  assert.equal(c.r.respostas.length, 2, 'antes da revisão a repetição ficava calada por 48 h');
  assert.match(c.r.respostas[1], /^Já está confirmado, Maria! ✅ Te esperamos na sua sessão sábado, 17\/10 às 09:00/);
  assert.deepEqual(c.r.confirmados, [9001], 'a franquia é confirmada uma vez só');
});

test('item 2 — o mesmo agendamento confirmado de novo por OUTRO lembrete (véspera e depois o do dia): responde "já está"', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  await c.tocar('Confirmar presença');
  // depois da nossa resposta, sai o lembrete do dia (3 h antes) — a última fala volta a ser um lembrete
  const c2 = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida('A sua sessão de hoje está marcada para 09:00.', horasAntes(0.1)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  for (const [k, v] of c.r.marcas) c2.r.marcas.set(k, new Date(v.getTime() - 3600_000));
  const r = await c2.tocar('Confirmar presença');
  assert.equal(r?.resposta, 'repetida');
  assert.equal(c2.r.respostas.length, 1);
  assert.match(c2.r.respostas[0], /^Já está confirmado/);
  assert.deepEqual(c2.r.confirmados, []);
});

test('depois da nossa resposta, um toque DIFERENTE ("Preciso remarcar") é tratado para o mesmo agendamento', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  await c.tocar('Confirmar presença');
  const r = await c.tocar('Preciso remarcar');
  assert.equal(r?.resposta, 'remarcar');
  assert.equal(r?.tipo, 'sessao');
  assert.equal(c.r.tarefas.length, 1);
  assert.match(c.r.tarefas[0], /remarcar a sessão de sábado, 17\/10 às 09:00/);
});

test('lembrete NOVO de outro agendamento depois de um toque já respondido: confirma o novo, não responde "já está"', async () => {
  const c = cenario({
    lead: cartao({ 1: CONSULTA_S, 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [
      agendamento({ utc: '2026-10-17T12:00:00Z' }),
      agendamento({ utc: '2026-10-17T17:30:00Z', idSchedule: 3738045, categoryName: 'Avaliação', idTreatment: null }),
    ],
  });
  await c.tocar('Confirmar presença');
  // depois, sai a véspera da CONSULTA de 14:30 e o paciente toca de novo
  const c2 = cenario({
    lead: cartao({ 1: CONSULTA_S, 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_CONSULTA, horasAntes(0.2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T17:30:00Z', idSchedule: 3738045, categoryName: 'Avaliação', idTreatment: null })],
  });
  for (const [k, v] of c.r.marcas) c2.r.marcas.set(k, new Date(v.getTime() - 3600_000));
  const r = await c2.tocar('Confirmar presença');
  assert.equal(r?.resposta, 'confirmou');
  assert.equal(r?.tipo, 'consulta');
  assert.deepEqual(c2.r.confirmados, [3738045]);
});

test('dois toques no mesmo instante (duplo clique): uma resposta e uma confirmação só', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  const [a, b] = await Promise.all([c.tocar('Confirmar presença'), c.tocar('Confirmar presença')]);
  assert.deepEqual([a?.resposta, b?.resposta].sort(), ['confirmou', 'repetida']);
  assert.equal(c.r.respostas.length, 1);
  assert.deepEqual(c.r.confirmados, [9001]);
});

test('"Preciso remarcar" → tarefa para a equipe + resposta; NADA na franquia', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Preciso remarcar', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  const r = await c.tocar('Preciso remarcar');
  assert.equal(r?.resposta, 'remarcar');
  assert.deepEqual(c.r.confirmados, []);
  assert.equal(c.r.tarefas.length, 1);
  assert.match(c.r.tarefas[0], /🔁 Pediu para remarcar a sessão de sábado, 17\/10 às 09:00/);
  assert.match(c.r.respostas[0], /^Sem problema, Maria! 🙏/);
});

test('agendamento não bate com o horário do cartão → responde, NÃO confirma, e abre tarefa para a equipe', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida('A sua sessão é amanhã. Confirma?', horasAntes(2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T15:00:00Z' })],
  });
  const r = await c.tocar('Confirmar presença');
  assert.equal(r?.franquia, 'sem_consulta');
  assert.deepEqual(c.r.confirmados, []);
  assert.equal(c.r.respostas.length, 1);
  assert.equal(c.r.tarefas.length, 1);
  assert.match(c.r.tarefas[0], /CONFIRMOU pelo WhatsApp a sessão.*sem sessão/);
});

test('só no papel: não responde nem escreve — registra na tela o que faria e deixa a Sofia seguir', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'confirmar-sessao', estado: 'seco' }]);
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Confirmar presença', horasAntes(0.01))],
    schedules: [agendamento({ utc: '2026-10-17T12:00:00Z' })],
  });
  const r = await c.tocar('Confirmar presença', {} as NodeJS.ProcessEnv);
  assert.equal(r, null);
  assert.equal(c.r.respostas.length, 0);
  assert.equal(c.r.tarefas.length, 0);
  assert.deepEqual(c.r.confirmados, []);
  assert.equal(c.r.marcas.size, 0);
  assert.equal(c.r.simulados.length, 1);
  assert.equal(c.r.simulados[0].acao, 'gravaria');
  assert.match(String(c.r.simulados[0].motivo), /agendamento 9001/);
});

test('chaves desligadas: nem lê a conversa nem o cartão', async () => {
  const c = cenario({ lead: cartao({ 2: SESSAO_S }), conversa: [saida(VESPERA_SESSAO, horasAntes(2))], schedules: [] });
  assert.equal(await c.tocar('Confirmar presença', {} as NodeJS.ProcessEnv), null);
  assert.equal(c.r.leituras, 0);
});

test('conversa oficial ilegível: sem prova, segue para a Sofia', async () => {
  const c = cenario({ lead: cartao({ 2: SESSAO_S, 3: 555 }), conversa: null, schedules: [] });
  assert.equal(await c.tocar('Confirmar presença'), null);
  assert.equal(c.r.respostas.length, 0);
});

test('franquia fora do ar: responde, não confirma e avisa a equipe (o "não sei" nunca vira "confirmado")', async () => {
  const c = cenario({
    lead: cartao({ 2: SESSAO_S, 3: 555 }),
    conversa: [saida(VESPERA_SESSAO, horasAntes(2)), entrada('Confirmar', horasAntes(0.01))],
    schedules: null,
  });
  const r = await c.tocar('Confirmar');
  assert.equal(r?.franquia, 'sem_consulta');
  assert.deepEqual(c.r.confirmados, []);
  assert.equal(c.r.tarefas.length, 1);
  assert.match(c.r.respostas[0], /sábado, 17\/10 às 09:00/);
});
