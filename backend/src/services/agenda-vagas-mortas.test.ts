import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAgenda } from './agenda.service.js';
import { SPINE_STATUS, pesoNaGrade } from './spine.service.js';
import type { SpineSchedule } from './spine.service.js';

/**
 * Bebedouro, 21/10/2026 15:04: a IA disse à Marinês "amanhã não tem vaga, o mais próximo é 04/11". Em 22/10
 * havia 11:30 (desmarcado às 13:47) e 15:00 e 15:30 (sessões remarcadas) — e, de 23/10 a 03/11, mais 13
 * horários só com registro REMARCADO/DESMARCADO. Um fisioterapeuta, agenda cheia: as vagas são exatamente essas.
 *
 * 22/10/2026 é uma quinta-feira.
 */
const D = '2026-10-22';
const CFG = { start: '08:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:30', days: [1, 2, 3, 4, 5], slotMinutes: 30 };
const RANGE = { initialDate: D, endDate: D };
const CEDO = `${D}T00:01:00`;

const ag = (timeLocal: string, idStatus: number): SpineSchedule =>
  ({ dayLocal: D, timeLocal, idStatus, statusName: String(idStatus), ...pesoNaGrade(idStatus) }) as SpineSchedule;

const slot = (slots: ReturnType<typeof buildAgenda>, hora: string) => slots.find((s) => s.time === hora);

test('REMARCADO não ocupa: o paciente foi pra outro dia', () => {
  assert.deepEqual(pesoNaGrade(SPINE_STATUS.REMARCADO), { isBusy: false, requiresManualValidation: true });
  assert.deepEqual(pesoNaGrade(SPINE_STATUS.DESMARCADO), { isBusy: false, requiresManualValidation: true });
});

test('o que tem paciente de pé continua ocupando — e status desconhecido também', () => {
  for (const st of [SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.ATENDIDO, SPINE_STATUS.NAO_COMPARECEU]) {
    assert.equal(pesoNaGrade(st).isBusy, true, `status ${st}`);
  }
  assert.equal(pesoNaGrade(null).isBusy, true);
  assert.equal(pesoNaGrade(99).isBusy, true);
});

test('horário remarcado num turno com atendimento sai incerto e sondável', () => {
  const slots = buildAgenda(CFG, [ag('14:00', SPINE_STATUS.AGENDADO), ag('15:00', SPINE_STATUS.REMARCADO)], RANGE, CEDO);
  const s = slot(slots, '15:00');
  assert.equal(s?.status, 'incerto');
  assert.equal(s?.turnoComAtendimento, true);
});

test('turno sem nenhum paciente ativo = provável bloqueio: incerto, mas não sondável', () => {
  // a recepção bloqueou a tarde e desmarcou todo mundo — a API não mostra o bloqueio
  const slots = buildAgenda(
    CFG,
    [ag('09:00', SPINE_STATUS.AGENDADO), ag('14:00', SPINE_STATUS.DESMARCADO), ag('15:00', SPINE_STATUS.REMARCADO)],
    RANGE,
    CEDO,
  );
  assert.equal(slot(slots, '14:00')?.turnoComAtendimento, false);
  assert.equal(slot(slots, '15:00')?.turnoComAtendimento, false);
});

test('paciente marcado em cima do remarcado: ocupado', () => {
  const slots = buildAgenda(CFG, [ag('15:00', SPINE_STATUS.REMARCADO), ag('15:00', SPINE_STATUS.AGENDADO)], RANGE, CEDO);
  assert.equal(slot(slots, '15:00')?.status, 'ocupado');
});

test('horário morto que encosta numa consulta ativa (grade de 45 min) fica ocupado', () => {
  const cfg = { start: '09:00', end: '10:30', lunchStart: null, lunchEnd: null, days: [4], slotMinutes: 45 } as never;
  const slots = buildAgenda(cfg, [ag('09:45', SPINE_STATUS.DESMARCADO), ag('10:00', SPINE_STATUS.AGENDADO)], RANGE, CEDO);
  assert.equal(slot(slots, '09:45')?.status, 'ocupado');
});
