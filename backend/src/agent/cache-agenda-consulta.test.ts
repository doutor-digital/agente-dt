/**
 * Cache curto da busca de horários × as ferramentas da Sofia (decisão do João, 21/10/2026).
 *
 * consultar_horarios lista os horários na franquia e SONDA até 4 deles (marca e cancela um agendamento de teste).
 * Ligado, a segunda conversa da mesma unidade no mesmo dia, poucos minutos depois, não vai à franquia; só no papel,
 * vai sempre e mede. Marcar, ou a marcação falhar por horário ocupado, apaga o dia. O carimbo da consulta (#104) é a
 * hora em que a FRANQUIA foi consultada.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SpineService } from '../services/spine.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { buildAgendarConsulta, buildConsultarHorarios } from './agenda-tools.js';
import { quandoFoiConsultada } from './horario-oferecido.js';
import { agoraLocalISO } from './consulta-que-passou.js';
import { feriadoNacional } from '../lib/feriados.js';
import { AUTOMACAO_CACHE_AGENDA, MARCA_APAGADO, _depsDoCacheParaTeste, depositoNaMemoria, guardarNoCache } from '../lib/cache-agenda.js';
import { _semearParaTeste, type Estado } from '../lib/automacoes-estado.js';
import { _semearCrmParaTeste } from '../lib/crm-compartilhado.js';
import type { Simulacao } from '../lib/so-no-papel.js';

const SLUG = 'doutor-hernia-araguaina';
const TZ = 'America/Sao_Paulo';

const unidade = {
  id: 'u-ara',
  slug: SLUG,
  name: 'Araguaína',
  spineEnabled: true,
  spineToken: 'tok',
  spineAiPaused: false,
  spineBookingRequiresPayment: false,
  spineTimezone: TZ,
  businessHoursTimezone: TZ,
  spineAgendaStart: '08:00',
  spineAgendaEnd: '18:00',
  spineLunchStart: '12:00',
  spineLunchEnd: '13:00',
  spineAgendaDays: [0, 1, 2, 3, 4, 5, 6],
  spineSlotMinutes: 60,
  spineDayHours: null,
  spineStaffPorTurno: null,
} as unknown as Unit;

/** Um dia uns dias à frente, fora de feriado: o relógio de verdade não deixa os horários vencidos. */
function diaDeTeste(): string {
  let t = Date.now() + 5 * 86_400_000;
  while (feriadoNacional(agoraLocalISO(TZ, new Date(t)).slice(0, 10))) t += 86_400_000;
  return agoraLocalISO(TZ, new Date(t)).slice(0, 10);
}
const DIA = diaDeTeste();

Object.defineProperty(prisma, 'unit', { value: { findUnique: async () => unidade }, configurable: true });
Object.defineProperty(prisma, 'spineLeadLink', {
  value: { findFirst: async () => ({ spineIdClient: 999 }), findUnique: async () => null, upsert: async () => ({}) },
  configurable: true,
});
Object.defineProperty(prisma, 'agendaBlock', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'conversation', { value: { updateMany: async () => ({ count: 0 }) }, configurable: true });

/** O que foi pedido à franquia, na ordem. */
const franquia: string[] = [];
/** "AAAA-MM-DD HH:MM" já marcado na franquia (a grade vê). */
const ocupados = new Set<string>();
/** "AAAA-MM-DDTHH:MM:00" que a franquia recusa ao marcar (a grade não vê — bloqueio). */
const recusa = new Set<string>();
/** "AAAA-MM-DD HH:MM" → status de quem desmarcou (57) ou remarcou (41): a grade vê o registro, que não ocupa. */
const mortos = new Map<string, number>();
let falhaNaGrade = false;
let cancelamentoFalha = false;
let seq = 100;

const spine = SpineService as unknown as Record<string, unknown>;
spine.searchSchedules = async (_u: Unit, f: { initialDate: string }) => {
  franquia.push(`grade ${f.initialDate}`);
  if (falhaNaGrade) return { ok: false, error: '500 da franquia' };
  const schedules = [...ocupados]
    .filter((k) => k.startsWith(f.initialDate))
    .map((k) => ({ idSchedule: ++seq, dayLocal: k.slice(0, 10), timeLocal: k.slice(11, 16), isBusy: true, requiresManualValidation: false, statusName: 'Agendado', idStatus: 1 }))
    .concat(
      [...mortos]
        .filter(([k]) => k.startsWith(f.initialDate))
        .map(([k, idStatus]) => ({ idSchedule: ++seq, dayLocal: k.slice(0, 10), timeLocal: k.slice(11, 16), isBusy: false, requiresManualValidation: true, statusName: String(idStatus), idStatus })),
    );
  return { ok: true, data: { schedules, total: schedules.length, pages: 1 } };
};
spine.createSchedule = async (_u: Unit, input: { idClient: number; dateAttendanceLocal: string }) => {
  franquia.push(`marca ${input.dateAttendanceLocal}${input.idClient === 999 ? ' (sondagem)' : ''}`);
  if (recusa.has(input.dateAttendanceLocal)) return { ok: false, error: '400: Horário não disponível' };
  return { ok: true, data: { idSchedule: ++seq } };
};
spine.cancelSchedule = async () => {
  franquia.push('cancela');
  return cancelamentoFalha ? { ok: false, error: '500 da franquia' } : { ok: true };
};
spine.getClient = async () => ({ ok: true, data: { client: { idClient: 9, name: 'Maria Teste', whatsapp: null, schedules: [] } } });

const passos: Array<{ title: string; payload?: unknown }> = [];
const recorder = {
  traceId: 'trace-teste',
  step: async (s: { title: string; payload?: unknown }) => {
    passos.push(s);
  },
} as unknown as TraceRecorder;

let deposito: ReturnType<typeof depositoNaMemoria>;
let registros: Simulacao[];

function chave(estado: Estado) {
  _semearParaTeste([{ slug: SLUG, automacao: AUTOMACAO_CACHE_AGENDA, estado }]);
}

beforeEach(() => {
  franquia.length = 0;
  passos.length = 0;
  ocupados.clear();
  recusa.clear();
  mortos.clear();
  falhaNaGrade = false;
  cancelamentoFalha = false;
  deposito = depositoNaMemoria();
  registros = [];
  _depsDoCacheParaTeste({ deposito, env: {}, registrar: (_u, _a, s) => registros.push(s) });
  _semearCrmParaTeste([]);
  chave('ligado');
});
after(() => {
  _depsDoCacheParaTeste();
  _semearParaTeste([]);
});

// pela `func`, como o grafo faz (fixarLeadDaConversa): o `leadId` não está no schema da ferramenta
const consultar = (leadId: number, data = DIA) =>
  (buildConsultarHorarios({ unit: unidade, recorder, estado: { consultou: false } }) as unknown as { func: (a: unknown) => Promise<string> }).func({ data, leadId });
/** A lista "HH:MM, HH:MM" que a ferramenta devolveu (sem o carimbo, que também tem hora). */
const horariosDe = (texto: string) => /\(\d{4}-\d{2}-\d{2}\): ([\d:, ]+)\./.exec(texto)?.[1].split(', ') ?? [];
const vaiAFranquia = () => franquia.some((c) => c.startsWith('grade') || c.includes('(sondagem)'));

test('ligado: a 2ª conversa, minutos depois, recebe os mesmos horários sem ir à franquia (nem grade, nem sondagem)', async () => {
  const primeira = await consultar(1);
  assert.match(primeira, /Horários CONFIRMADOS/);
  assert.ok(franquia.filter((c) => c.includes('(sondagem)')).length > 0, 'a 1ª sondou');
  assert.equal(deposito.linhas.length, 1, 'guardou o dia');

  franquia.length = 0;
  const segunda = await consultar(2);
  assert.deepEqual(franquia, [], 'a 2ª não tocou a franquia');
  assert.equal(segunda.split('(Agenda consultada')[0], primeira.split('(Agenda consultada')[0], 'os mesmos horários');
  const passo = passos.at(-1) as { title: string; payload: { cache: { teria: string; usou: boolean } } };
  assert.match(passo.title, /do cache/);
  assert.deepEqual([passo.payload.cache.teria, passo.payload.cache.usou], ['hit', true]);
});

test('#104: vindo do cache, o carimbo é a hora em que a FRANQUIA foi consultada, não agora', async () => {
  const seteMinAtras = new Date(Date.now() - 7 * 60_000);
  await guardarNoCache(
    unidade,
    DIA,
    undefined,
    { todosLivres: ['08:00', '09:00', '14:00'], livres: ['08:00', '09:00', '14:00'], oferecer: ['09:00', '14:00'], recusados: [], sondados: ['09:00', '14:00'] },
    true,
    seteMinAtras,
  );
  const texto = await consultar(3);
  assert.deepEqual(franquia, []);
  assert.deepEqual(horariosDe(texto), ['09:00', '14:00']);
  assert.equal(quandoFoiConsultada(texto), agoraLocalISO(TZ, seteMinAtras));
  assert.notEqual(quandoFoiConsultada(texto), agoraLocalISO(TZ, new Date()));
});

test('o horário de hoje que já passou não sai do cache (relógio da unidade)', async (t) => {
  const agora = agoraLocalISO(TZ);
  const hoje = agora.slice(0, 10);
  const hora = agora.slice(11, 16);
  if (feriadoNacional(hoje) || hora < '00:01' || hora >= '23:58') return t.skip('fora da janela em que o teste é determinístico');
  await guardarNoCache(
    unidade,
    hoje,
    undefined,
    { todosLivres: ['00:00', '23:59'], livres: ['00:00', '23:59'], oferecer: ['00:00', '23:59'], recusados: [], sondados: ['00:00', '23:59'] },
    true,
    new Date(Date.now() - 60_000),
  );
  const texto = await consultar(4, hoje);
  assert.deepEqual(franquia, []);
  assert.deepEqual(horariosDe(texto), ['23:59']);
});

test('só no papel: vai à franquia mesmo com o dia guardado e mede — "diverge" quando o guardado ficou velho', async () => {
  await consultar(1); // guarda (ligado)
  const guardado = (deposito.linhas[0].resultado as { oferecer: string[] }).oferecer;
  assert.deepEqual(guardado, ['08:00', '11:00', '14:00', '17:00']);
  chave('seco');
  ocupados.add(`${DIA} ${guardado[0]}`); // a recepção marcou direto na franquia

  franquia.length = 0;
  const texto = await consultar(5);
  assert.ok(vaiAFranquia(), 'no papel a busca roda igual');
  assert.ok(!horariosDe(texto).includes(guardado[0]), 'oferece o que a franquia diz agora');
  assert.ok(horariosDe(texto).length > 0);
  const passo = passos.at(-1) as { payload: { cache: { teria: string; usou: boolean } } };
  assert.deepEqual([passo.payload.cache.teria, passo.payload.cache.usou], ['hit', false]);
  assert.equal(registros.length, 1);
  assert.equal(registros[0].acao, 'diverge');
  assert.equal(registros[0].leadId, 5);
  assert.match(String(registros[0].motivo), new RegExp(`${guardado[0]} já não está livre`));
});

test('só no papel sem nada guardado: "pularia", e grava para a próxima medir', async () => {
  chave('seco');
  await consultar(6);
  assert.ok(vaiAFranquia());
  assert.equal(registros[0]?.acao, 'pularia');
  assert.equal(deposito.linhas.length, 1, 'no papel também guarda — é o que dá a taxa de acerto real');
});

test('marcar pela Sofia apaga o dia: a próxima busca vai à franquia', async () => {
  const oferta = await consultar(1);
  const hora = horariosDe(oferta)[0];
  const r = await buildAgendarConsulta({ unit: unidade, recorder }).invoke({ idClient: 9, data: DIA, hora, diaConfirmado: true, formaPagamento: 'na_clinica' } as never);
  assert.match(String(r), /Consulta marcada/);
  assert.equal(deposito.linhas.filter((l) => l.chave !== MARCA_APAGADO).length, 0, 'apagou o dia');

  ocupados.add(`${DIA} ${hora}`);
  franquia.length = 0;
  const depois = await consultar(2);
  assert.ok(vaiAFranquia(), 'buscou de novo');
  assert.ok(horariosDe(depois).length > 0 && !horariosDe(depois).includes(hora), 'o horário marcado não volta');
});

test('marcação que falha por horário OCUPADO (na grade ou recusado pela franquia) apaga o dia', async () => {
  const oferta = await consultar(1);
  const [h1, h2] = horariosDe(oferta);

  ocupados.add(`${DIA} ${h1}`); // a recepção marcou por fora
  const r1 = await buildAgendarConsulta({ unit: unidade, recorder }).invoke({ idClient: 9, data: DIA, hora: h1, diaConfirmado: true, formaPagamento: 'na_clinica' } as never);
  assert.match(String(r1), /não está mais disponível/);
  assert.equal(deposito.linhas.filter((l) => l.chave !== MARCA_APAGADO).length, 0);

  await consultar(2); // guarda de novo
  assert.equal(deposito.linhas.filter((l) => l.chave !== MARCA_APAGADO).length, 1);
  recusa.add(`${DIA}T${h2}:00`); // bloqueio que só a franquia vê
  const r2 = await buildAgendarConsulta({ unit: unidade, recorder }).invoke({ idClient: 9, data: DIA, hora: h2, diaConfirmado: true, formaPagamento: 'na_clinica' } as never);
  assert.match(String(r2), /Não consegui marcar/);
  assert.equal(deposito.linhas.filter((l) => l.chave !== MARCA_APAGADO).length, 0);
});

test('nunca guarda erro nem vazio: franquia fora do ar, ou sondagem que recusa tudo', async () => {
  falhaNaGrade = true;
  const r = await consultar(1);
  assert.match(r, /Não consegui consultar a agenda/);
  assert.equal(deposito.linhas.length, 0);

  falhaNaGrade = false;
  for (const h of ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00']) {
    for (let d = 0; d < 31; d++) {
      const dia = agoraLocalISO(TZ, new Date(Date.parse(`${DIA}T12:00:00Z`) + d * 86_400_000)).slice(0, 10);
      recusa.add(`${dia}T${h}:00`);
    }
  }
  await consultar(2);
  assert.equal(deposito.linhas.length, 0, 'dia em que a sondagem recusou tudo não entra');

  franquia.length = 0;
  await consultar(3);
  assert.ok(vaiAFranquia(), 'e a próxima busca vai à franquia');
});

test('desligada: não lê nem grava — toda busca vai à franquia, como antes', async () => {
  chave('desligado');
  await consultar(1);
  franquia.length = 0;
  await consultar(2);
  assert.ok(vaiAFranquia());
  assert.equal(deposito.linhas.length, 0);
  assert.equal(registros.length, 0);
});

test('sondagem que deixou agendamento fantasma (cancelamento falhou) não entra no cache', async () => {
  cancelamentoFalha = true;
  const texto = await consultar(1);
  assert.match(texto, /Horários CONFIRMADOS/, 'a busca responde como sempre');
  assert.equal(deposito.linhas.length, 0, 'mas o dia não é guardado: a próxima busca vê o horário ocupado na grade');
});

// Bebedouro, 21/10/2026: agenda cheia, e a IA dizia "o mais próximo é 04/11" com horários de quem remarcou ou
// desmarcou vagos no dia seguinte. Grade daqui: 08–11 e 13–17, de hora em hora.
const GRADE = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

test('dia cheio com um remarcado numa manhã de atendimento: a sondagem confirma e a IA oferece', async () => {
  chave('desligado');
  for (const h of GRADE) if (h !== '10:00') ocupados.add(`${DIA} ${h}`);
  mortos.set(`${DIA} 10:00`, 41);
  const r = await consultar(1);
  assert.match(r, new RegExp(`\\(${DIA}\\): 10:00\\.`));
  assert.ok(franquia.includes(`marca ${DIA}T10:00:00 (sondagem)`));
});

test('a franquia recusa o horário morto (bloqueio que a grade não vê): não oferece', async () => {
  chave('desligado');
  for (const h of GRADE) if (h !== '10:00') ocupados.add(`${DIA} ${h}`);
  mortos.set(`${DIA} 10:00`, 57);
  recusa.add(`${DIA}T10:00:00`);
  const r = await consultar(1);
  assert.doesNotMatch(r, new RegExp(`\\(${DIA}\\)`));
});

test('tarde sem ninguém ativo e só desmarcados = provável bloqueio: nem sonda', async () => {
  chave('desligado');
  for (const h of GRADE) if (h < '12:00') ocupados.add(`${DIA} ${h}`);
  for (const h of GRADE) if (h > '12:00') mortos.set(`${DIA} ${h}`, 57);
  const r = await consultar(1);
  assert.doesNotMatch(r, new RegExp(`\\(${DIA}\\)`));
  assert.ok(!franquia.some((c) => c.startsWith(`marca ${DIA}T1`) && c.includes('(sondagem)')), 'sondou horário de turno bloqueado');
});

test('marcar no horário remarcado oferecido passa pela trava da grade', async () => {
  chave('desligado');
  for (const h of GRADE) if (h !== '10:00') ocupados.add(`${DIA} ${h}`);
  mortos.set(`${DIA} 10:00`, 41);
  assert.deepEqual(horariosDe(await consultar(1)), ['10:00']);
  const r = await buildAgendarConsulta({ unit: unidade, recorder }).invoke({ idClient: 9, data: DIA, hora: '10:00', diaConfirmado: true, formaPagamento: 'na_clinica' } as never);
  assert.match(String(r), /Consulta marcada/);
  assert.ok(franquia.includes(`marca ${DIA}T10:00:00`), 'marcou de verdade, com o paciente');
});

test('horário morto em turno sem atendimento: a trava de marcar recusa', async () => {
  for (const h of GRADE) if (h < '12:00') ocupados.add(`${DIA} ${h}`);
  mortos.set(`${DIA} 15:00`, 57);
  const r = await buildAgendarConsulta({ unit: unidade, recorder }).invoke({ idClient: 9, data: DIA, hora: '15:00', diaConfirmado: true, formaPagamento: 'na_clinica' } as never);
  assert.match(String(r), /não está mais disponível/);
  assert.ok(!franquia.includes(`marca ${DIA}T15:00:00`));
});
