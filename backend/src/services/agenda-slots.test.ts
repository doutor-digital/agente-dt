import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAgenda } from './agenda.service.js';
import type { AgendaBlockInput } from './agenda.service.js';
import type { SpineSchedule } from './spine.service.js';

/** Só os campos que buildAgenda lê; o resto do SpineSchedule não influi aqui. */
const marcado = (
  timeLocal: string,
  over: Partial<SpineSchedule> = {},
): SpineSchedule =>
  ({ dayLocal: DIA, timeLocal, isBusy: true, requiresManualValidation: false, ...over } as SpineSchedule);

/**
 * Esta é a função que decide QUAIS HORÁRIOS a IA oferece ao paciente. Um erro
 * aqui não aparece como erro: aparece como paciente marcando num horário que já
 * tem gente, ou desistindo porque ouviu "não tenho vaga" num dia vazio.
 *
 * 02/09/2026 é uma quarta-feira.
 */
const CFG = {
  start: '08:00',
  end: '12:00',
  lunchStart: '10:00',
  lunchEnd: '11:00',
  days: [1, 2, 3, 4, 5], // seg a sex
  slotMinutes: 30,
};

const DIA = '2026-09-02';
const RANGE = { initialDate: DIA, endDate: DIA };
const CEDO = `${DIA}T00:01:00`;

const horas = (slots: Array<{ time: string; status: string }>, st: string) =>
  slots.filter((s) => s.status === st).map((s) => s.time);

test('gera a grade toda de 30 em 30, pulando o almoço', () => {
  const slots = buildAgenda(CFG, [], RANGE, CEDO);
  assert.deepEqual(horas(slots, 'livre'), ['08:00', '08:30', '09:00', '09:30', '11:00', '11:30']);
});

test('horário com paciente marcado sai como ocupado', () => {
  const slots = buildAgenda(CFG, [marcado('09:00')], RANGE, CEDO);
  assert.ok(!horas(slots, 'livre').includes('09:00'));
  assert.ok(horas(slots, 'ocupado').includes('09:00'));
});

test('bloqueio da recepção tira o horário — foi o que faltou em Boa Vista', () => {
  const bloqueio: AgendaBlockInput[] = [
    { dayLocal: DIA, startTime: '08:00', endTime: '09:00', reason: 'Gravação' },
  ];
  const slots = buildAgenda(CFG, [], RANGE, CEDO, bloqueio);
  const livres = horas(slots, 'livre');
  assert.ok(!livres.includes('08:00'), 'bloqueado ainda apareceu como livre');
  assert.ok(!livres.includes('08:30'), 'bloqueio deve cobrir a faixa inteira');
  assert.ok(livres.includes('09:00'), 'o fim do bloqueio é exclusivo');
});

test('o bloqueio carrega o motivo, pra equipe entender', () => {
  const slots = buildAgenda(
    CFG, [], RANGE, CEDO,
    [{ dayLocal: DIA, startTime: '08:00', endTime: '08:30', reason: 'Feriado' }],
  );
  const b = slots.find((s) => s.time === '08:00');
  assert.equal(b?.status, 'bloqueado');
  assert.match(String(b?.motivo ?? ''), /Feriado/);
});

test('dia fora dos dias de atendimento não gera horário nenhum', () => {
  const sabado = '2026-09-05';
  const slots = buildAgenda(CFG, [], { initialDate: sabado, endDate: sabado }, `${sabado}T00:01:00`);
  assert.equal(slots.length, 0);
});

test('horário que já passou hoje não é oferecido', () => {
  const slots = buildAgenda(CFG, [], RANGE, `${DIA}T09:15:00`);
  const livres = horas(slots, 'livre');
  assert.ok(!livres.includes('08:00'), 'ofereceu horário que já passou');
  assert.ok(!livres.includes('09:00'), 'ofereceu horário que já passou');
  assert.ok(livres.includes('11:00'), 'deveria sobrar o da tarde');
});

test('agendamento que a franquia manda validar à mão não conta como livre', () => {
  const slots = buildAgenda(
    CFG,
    [marcado('09:00', { isBusy: false, requiresManualValidation: true })],
    RANGE, CEDO,
  );
  assert.ok(!horas(slots, 'livre').includes('09:00'));
});

test('configuração inválida devolve vazio em vez de inventar horário', () => {
  assert.deepEqual(buildAgenda({ ...CFG, start: '18:00', end: '08:00' }, [], RANGE, CEDO), []);
  assert.deepEqual(buildAgenda({ ...CFG, start: 'xx:yy' }, [], RANGE, CEDO), []);
});

test('sem almoço configurado, a grade não tem buraco', () => {
  const slots = buildAgenda(
    { ...CFG, lunchStart: null, lunchEnd: null } as unknown as typeof CFG, [], RANGE, CEDO,
  );
  assert.ok(horas(slots, 'livre').includes('10:00'));
});

test('bloqueio de outro dia não afeta este', () => {
  const slots = buildAgenda(
    CFG, [], RANGE, CEDO,
    [{ dayLocal: '2026-09-03', startTime: '08:00', endTime: '12:00', reason: 'Feriado' }],
  );
  assert.ok(horas(slots, 'livre').includes('08:00'));
});

test('feriado nacional bloqueia a grade inteira, com o motivo (07/09/2026 — Independência)', () => {
  const FERIADO = '2026-09-07'; // segunda-feira
  const slots = buildAgenda(CFG, [], { initialDate: FERIADO, endDate: FERIADO }, `${FERIADO}T00:01:00`);
  assert.ok(slots.length > 0, 'o dia é útil na grade, então os slots existem');
  assert.deepEqual(horas(slots, 'livre'), [], 'nenhum horário livre num feriado nacional');
  assert.ok(slots.every((s) => s.status === 'bloqueado' && /feriado nacional — Independência/.test(String(s.motivo))));
});

test('sábado com janela própria: 07h–13h sem almoço, enquanto a semana segue o padrão', () => {
  const SAB = '2026-09-12'; // sábado
  const cfg = { ...CFG, days: [1, 2, 3, 4, 5, 6], dayHours: { '6': { start: '07:00', end: '13:00' } } };
  const sab = buildAgenda(cfg, [], { initialDate: SAB, endDate: SAB }, `${SAB}T00:01:00`);
  assert.equal(horas(sab, 'livre')[0], '07:00');
  assert.equal(horas(sab, 'livre').at(-1), '12:30');
  assert.ok(horas(sab, 'livre').includes('10:00'), 'sábado não tem o almoço da semana');
  const semana = buildAgenda(cfg, [], RANGE, CEDO);
  assert.deepEqual(horas(semana, 'livre'), ['08:00', '08:30', '09:00', '09:30', '11:00', '11:30'], 'a semana não muda');
});

test('sábado ligado SEM janela própria usa o horário da semana (comportamento antigo)', () => {
  const SAB = '2026-09-12';
  const sab = buildAgenda({ ...CFG, days: [1, 2, 3, 4, 5, 6] }, [], { initialDate: SAB, endDate: SAB }, `${SAB}T00:01:00`);
  assert.deepEqual(horas(sab, 'livre'), ['08:00', '08:30', '09:00', '09:30', '11:00', '11:30']);
});

// ── Sobreposição: grade de 45 min sobre consultas de 30 (Mossoró, 19–20/10/2026) ─────────────────
// Desde 02/10 Mossoró oferece de 45 em 45 a partir das 07:30, mas as consultas antigas seguem em :00/:30.
// A grade só via o início exato: 09:45 parecia livre com consulta às 10:00, a Sofia sondava, a franquia
// recusava ("400: Horário não disponível", 79 vezes em 48 h) e o dia saía com 2 de 9 horários.

const MOSSORO = {
  start: '07:30',
  end: '19:30',
  lunchStart: null,
  lunchEnd: null,
  days: [1, 2, 3, 4, 5],
  slotMinutes: 45,
} as unknown as typeof CFG;

const noDia = (dia: string, ...horarios: string[]): SpineSchedule[] =>
  horarios.map((h) => ({ dayLocal: dia, timeLocal: h, isBusy: true, requiresManualValidation: false, statusName: 'AGENDADO' } as SpineSchedule));

test('Mossoró 20/10: os dois horários que a franquia recusou saem da grade, os dois que ela aceitou ficam', () => {
  const DIA20 = '2026-10-20';
  // A agenda da franquia de 20/10 como estava quando a Sofia consultou (19/10 12:12), com os dois fisioterapeutas.
  const agenda = noDia(DIA20, '07:30', '08:15', '09:00', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
    '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00');
  const livres = horas(buildAgenda(MOSSORO, agenda, { initialDate: DIA20, endDate: DIA20 }, '2026-10-19T12:12:00'), 'livre');
  // Antes: 09:45, 11:15, 12:45, 13:30, 14:15, 15:45, 17:15, 18:00, 18:45. A sondagem testou 4 e a franquia
  // recusou 09:45 (consulta às 10:00) e 15:45 (15:30 e 16:00), e aceitou 13:30 e 18:45.
  assert.ok(!livres.includes('09:45'), '09:45 encosta na consulta das 10:00');
  assert.ok(!livres.includes('15:45'), '15:45 encosta nas das 15:30 e 16:00');
  assert.ok(livres.includes('13:30'), 'a franquia aceitou 13:30 com consulta às 14:00');
  assert.ok(livres.includes('18:45'), 'a franquia aceitou 18:45');
  assert.deepEqual(livres, ['13:30', '18:00', '18:45']);
});

test('Mossoró 22/10 de manhã: sobra só o 10:30, o único que a franquia aceitou', () => {
  const DIA22 = '2026-10-22';
  const agenda = noDia(DIA22, '07:30', '08:00', '08:30', '09:00', '10:00', '11:00', '11:30');
  const manha = horas(buildAgenda(MOSSORO, agenda, { initialDate: DIA22, endDate: DIA22 }, '2026-10-19T16:04:00'), 'livre')
    .filter((h) => h < '12:00');
  // A sondagem de 19/10 16:04 recusou 08:15, 09:45 e 11:15 e aceitou 10:30 (entre as consultas das 10:00 e 11:00).
  assert.deepEqual(manha, ['10:30']);
});

test('consulta às 08:30 tira o 08:15 da grade de 45; o 09:00 fica, porque a franquia aceita encostado', () => {
  const D = '2026-10-21';
  const slots = buildAgenda(MOSSORO, noDia(D, '08:30'), { initialDate: D, endDate: D }, `${D}T00:01:00`);
  const s0815 = slots.find((s) => s.time === '08:15');
  assert.equal(s0815?.status, 'ocupado');
  assert.match(String(s0815?.motivo), /encosta na consulta das 08:30/);
  // 30 min de distância já não é sobreposição: foi assim que a franquia aceitou 10:30 ao lado das 10:00 (22/10).
  assert.ok(horas(slots, 'livre').includes('09:00'));
  assert.ok(horas(slots, 'livre').includes('07:30'));
});

test('grade de 30 min com consulta às 09:00: os vizinhos 08:30 e 09:30 continuam livres (nada muda nas outras unidades)', () => {
  const livres = horas(buildAgenda(CFG, [marcado('09:00')], RANGE, CEDO), 'livre');
  assert.deepEqual(livres, ['08:00', '08:30', '09:30', '11:00', '11:30']);
});

test('desmarcado fora da grade não tira os vizinhos: só o horário exato fica incerto', () => {
  const D = '2026-10-21';
  const desmarcado = { dayLocal: D, timeLocal: '08:30', isBusy: false, requiresManualValidation: true } as SpineSchedule;
  const livres = horas(buildAgenda(MOSSORO, [desmarcado], { initialDate: D, endDate: D }, `${D}T00:01:00`), 'livre');
  assert.ok(livres.includes('08:15'));
  assert.ok(livres.includes('09:00'));
});

test('a sobreposição é de blocos de 30 min — encostar não é cruzar (achado do Codex conferido)', () => {
  const D = '2026-10-21';
  // Grade de um horário só: 09:00 (45 min, até 10:00).
  const cfg = { start: '09:00', end: '10:00', lunchStart: null, lunchEnd: null, days: [3], slotMinutes: 45 } as never;
  const status = (...h: string[]) =>
    buildAgenda(cfg, h.map((t) => ({ dayLocal: D, timeLocal: t, isBusy: true, requiresManualValidation: false }) as never), { initialDate: D, endDate: D }, `${D}T00:01:00`)
      .find((s) => s.time === '09:00')?.status;
  assert.equal(status('09:45'), 'livre', '09:00–09:30 não cruza 09:45–10:15');
  assert.equal(status('08:30'), 'livre', '08:30–09:00 só encosta');
  assert.equal(status('08:45'), 'ocupado', '08:45–09:15 cruza');
  assert.equal(status('09:20'), 'ocupado', '09:20–09:50 cruza');
});
