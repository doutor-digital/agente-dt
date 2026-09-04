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
