/**
 * `agendar_consulta` numa unidade SEM pagamento antecipado (Timbó, 29/10/2026).
 *
 * Antes: a ferramenta recusava marcar até o paciente escolher "Pix antecipado ou na clínica" e mandava a IA perguntar
 * isso com os botões — numa clínica que só recebe no dia. Agora, com `acceptsAdvancePayment = false`: só o dia é
 * exigido, a forma é "na clínica" implícita (mesmo que o modelo mande outra), e a escolha gravada na conversa é
 * `na_clinica` (é o que a régua de follow-up lê para não cobrar Pix). Com a flag ligada (padrão) nada muda.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SpineService } from '../services/spine.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { buildAgendarConsulta, buildConsultarHorarios } from './agenda-tools.js';
import { agoraLocalISO } from './consulta-que-passou.js';
import { feriadoNacional } from '../lib/feriados.js';
import { _depsDoCacheParaTeste, depositoNaMemoria } from '../lib/cache-agenda.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { _semearCrmParaTeste } from '../lib/crm-compartilhado.js';
import { PAGAMENTO_NO_DIA } from './pagamento-da-unidade.js';

const TZ = 'America/Sao_Paulo';

function unidade(over: Record<string, unknown> = {}): Unit {
  return {
    id: 'u-timbo',
    slug: 'doutor-hernia-timbo',
    name: 'Timbó',
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
    pixKey: '12.345.678/0001-90',
    pixHolder: 'Clinica Timbo LTDA',
    sourceProdutos: 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.',
    ...over,
  } as unknown as Unit;
}

function diaDeTeste(): string {
  let t = Date.now() + 5 * 86_400_000;
  while (feriadoNacional(agoraLocalISO(TZ, new Date(t)).slice(0, 10))) t += 86_400_000;
  return agoraLocalISO(TZ, new Date(t)).slice(0, 10);
}
const DIA = diaDeTeste();

let atual: Unit = unidade();
const gravacoes: Array<{ where: unknown; data: { pagamentoEscolhido?: string } }> = [];

Object.defineProperty(prisma, 'unit', { value: { findUnique: async () => atual }, configurable: true });
Object.defineProperty(prisma, 'spineLeadLink', {
  value: { findFirst: async () => ({ spineIdClient: 999 }), findUnique: async () => null, upsert: async () => ({}) },
  configurable: true,
});
Object.defineProperty(prisma, 'agendaBlock', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'conversation', {
  value: {
    updateMany: async (a: { where: unknown; data: { pagamentoEscolhido?: string } }) => {
      gravacoes.push(a);
      return { count: 1 };
    },
    findFirst: async () => null,
  },
  configurable: true,
});

const franquia: string[] = [];
let seq = 100;
const spine = SpineService as unknown as Record<string, unknown>;
spine.searchSchedules = async () => ({ ok: true, data: { schedules: [], total: 0, pages: 1 } });
spine.createSchedule = async (_u: Unit, input: { idClient: number; dateAttendanceLocal: string }) => {
  franquia.push(`marca ${input.dateAttendanceLocal}${input.idClient === 999 ? ' (sondagem)' : ''}`);
  return { ok: true, data: { idSchedule: ++seq } };
};
spine.cancelSchedule = async () => ({ ok: true });
spine.getClient = async () => ({ ok: true, data: { client: { idClient: 9, name: 'Maria Teste', whatsapp: null, schedules: [] } } });

const passos: Array<{ title: string; payload?: unknown }> = [];
const recorder = {
  traceId: 'trace-pag',
  step: async (s: { title: string; payload?: unknown }) => {
    passos.push(s);
  },
} as unknown as TraceRecorder;

beforeEach(() => {
  franquia.length = 0;
  passos.length = 0;
  gravacoes.length = 0;
  _depsDoCacheParaTeste({ deposito: depositoNaMemoria(), env: {}, registrar: () => undefined });
  _semearCrmParaTeste([]);
  _semearParaTeste([]);
});
after(() => {
  _depsDoCacheParaTeste();
  _semearParaTeste([]);
});

type Func = { func: (a: unknown) => Promise<string>; description: string; schema: { shape: Record<string, unknown> } };

async function primeiroHorario(u: Unit): Promise<string> {
  const consultar = buildConsultarHorarios({ unit: u, recorder, estado: { consultou: false } }) as unknown as Func;
  const texto = await consultar.func({ data: DIA, leadId: 1 });
  const h = /\(\d{4}-\d{2}-\d{2}\): ([\d:, ]+)\./.exec(texto)?.[1].split(', ')[0];
  assert.ok(h, `a grade devolveu horários: ${texto}`);
  return h;
}

const agendar = (u: Unit) => buildAgendarConsulta({ unit: u, recorder }) as unknown as Func;
const marcou = () => franquia.some((c) => c.startsWith('marca') && !c.includes('(sondagem)'));

test('sem antecipado: a ferramenta nem tem o parâmetro formaPagamento, e a descrição não manda perguntar pagamento', () => {
  const t = agendar(unidade({ acceptsAdvancePayment: false }));
  assert.equal('formaPagamento' in t.schema.shape, false);
  assert.doesNotMatch(t.description, /Pix antecipado|antecipad|forma de pagamento \(/i);
  assert.match(t.description, /NÃO pergunte nem fale de forma de pagamento/);
  // controle: com a flag ligada, igual a hoje
  const com = agendar(unidade());
  assert.equal('formaPagamento' in com.schema.shape, true);
  assert.match(com.description, /escolher a forma de pagamento \(Pix antecipado ou na clínica\)/);
});

test('sem antecipado: marca sem formaPagamento, grava na_clinica e a orientação é "paga no dia" (sem chave, sem valor antecipado)', async () => {
  atual = unidade({ acceptsAdvancePayment: false });
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /Consulta marcada para/);
  assert.ok(marcou(), 'chegou na franquia');
  assert.ok(r.includes(PAGAMENTO_NO_DIA), r);
  assert.doesNotMatch(r, /antecipad|12\.345\.678|ESCOLHEU PIX|\[\[botoes/i);
  assert.equal(gravacoes.length, 1);
  assert.equal(gravacoes[0].data.pagamentoEscolhido, 'na_clinica', 'a régua do Pix lê isto: nunca cobra');
});

test('sem antecipado: o modelo manda pix_antecipado (ou lixo) e a forma continua sendo na_clinica', async () => {
  atual = unidade({ acceptsAdvancePayment: false });
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1, formaPagamento: 'pix_antecipado' });
  assert.match(r, /Consulta marcada para/);
  assert.doesNotMatch(r, /antecipad|12\.345\.678|ESCOLHEU PIX/i);
  assert.equal(gravacoes[0].data.pagamentoEscolhido, 'na_clinica');
});

test('sem antecipado: a recusa por falta de confirmação do DIA continua — e não fala de pagamento', async () => {
  atual = unidade({ acceptsAdvancePayment: false });
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, leadId: 1 });
  assert.match(r, /^Consulta NÃO marcada ainda/);
  assert.match(r, /CONSEGUE ir nesse dia e horário/);
  assert.doesNotMatch(r, /antecipad|Pix|botoes|formaPagamento|prefere pagar/i);
  assert.ok(!marcou(), 'não marcou');
  assert.equal(gravacoes.length, 0);
  assert.match(String(passos.at(-1)?.title), /faltou confirmar o dia$/);
});

test('flag ligada (padrão): sem formaPagamento recusa com a pergunta e os botões, como sempre', async () => {
  atual = unidade();
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /perguntar como ele prefere pagar: Pix antecipado \(valor antecipado\) ou na clínica no dia/);
  assert.match(r, /\[\[botoes: Pix antecipado \| Na clínica\]\]/);
  assert.ok(!marcou());
  assert.match(String(passos.at(-1)?.title), /faltou confirmar o dia ou a forma de pagamento/);
});

test('flag ligada: pix_antecipado grava pix_antecipado e manda a chave e o valor, como sempre', async () => {
  atual = unidade();
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1, formaPagamento: 'pix_antecipado' });
  assert.match(r, /Ele escolheu PIX ANTECIPADO/);
  assert.match(r, /A chave Pix é 12\.345\.678\/0001-90/);
  assert.match(r, /O valor antecipado é R\$ 250/);
  assert.equal(gravacoes[0].data.pagamentoEscolhido, 'pix_antecipado');
});

test('flag ligada: na_clinica grava na_clinica e a orientação de hoje ("NÃO mencione Pix nem valor antecipado")', async () => {
  atual = unidade();
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1, formaPagamento: 'na_clinica' });
  assert.match(r, /Ele escolheu PAGAR NA CLÍNICA: NÃO mencione Pix nem valor antecipado/);
  assert.equal(gravacoes[0].data.pagamentoEscolhido, 'na_clinica');
});

test('flag false + taxa de reserva obrigatória (Boa Vista): a taxa vence, a pergunta de pagamento continua', async () => {
  atual = unidade({ acceptsAdvancePayment: false, spineBookingRequiresPayment: true });
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /perguntar como ele prefere pagar/);
  assert.ok(!marcou());
});

test('remarcação (remarcando) numa unidade sem antecipado: não passa pela porta e NÃO grava escolha de pagamento', async () => {
  atual = unidade({ acceptsAdvancePayment: false });
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, leadId: 1, remarcando: true });
  assert.match(r, /Consulta marcada para/);
  assert.equal(gravacoes.length, 0);
  assert.doesNotMatch(r, /antecipad/i);
});
