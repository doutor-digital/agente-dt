import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avaliacaoDePe } from './agenda-reconcile.service.js';
import { SPINE_STATUS, type SpineSchedule } from './spine.service.js';
import { renderConsultaMarcada } from '../agent/prompt-composer.js';

/**
 * Bebedouro, 21–22/10/2026 (Ignêz): a Melissa marcou a avaliação de 22/10 09:00 direto na franquia às 15:07; a IA,
 * que só enxerga a consulta que ela mesma marcou, marcou outra (04/11 14h) às 15:10 no mesmo cadastro. A recepção
 * pôs NÃO COMPARECEU na duplicada e a IA seguiu dizendo à filha "confirmado, 04/11 às 14h".
 */
const AGORA = '2026-10-21T15:10:00';

const ag = (dia: string, hora: string, idStatus: number, idTreatment: number | null = null): SpineSchedule =>
  ({ idSchedule: Number(dia.replace(/-/g, '') + hora.replace(':', '')), idTreatment, idStatus, dayLocal: dia, timeLocal: hora }) as SpineSchedule;

test('acha a avaliação que a recepção marcou', () => {
  const s = avaliacaoDePe([ag('2026-10-22', '09:00', SPINE_STATUS.AGENDADO)], AGORA);
  assert.equal(s?.dayLocal, '2026-10-22');
  assert.equal(s?.timeLocal, '09:00');
});

test('remarcada também vale: 41 é a consulta na data nova', () => {
  assert.ok(avaliacaoDePe([ag('2026-10-30', '10:00', SPINE_STATUS.REMARCADO)], AGORA));
});

test('desmarcada, não compareceu e atendida não são consulta de pé', () => {
  for (const st of [SPINE_STATUS.DESMARCADO, SPINE_STATUS.NAO_COMPARECEU, SPINE_STATUS.ATENDIDO]) {
    assert.equal(avaliacaoDePe([ag('2026-10-22', '09:00', st)], AGORA), null, `status ${st}`);
  }
});

test('sessão de tratamento não conta — é outra coisa', () => {
  assert.equal(avaliacaoDePe([ag('2026-10-22', '09:00', SPINE_STATUS.AGENDADO, 119461)], AGORA), null);
});

test('consulta que já passou não conta', () => {
  assert.equal(avaliacaoDePe([ag('2026-10-21', '09:00', SPINE_STATUS.AGENDADO)], AGORA), null);
});

test('com duas de pé, vale a mais próxima', () => {
  const s = avaliacaoDePe(
    [ag('2026-11-04', '14:00', SPINE_STATUS.AGENDADO), ag('2026-10-22', '09:00', SPINE_STATUS.AGENDADO)],
    AGORA,
  );
  assert.equal(s?.dayLocal, '2026-10-22');
});

test('NÃO COMPARECEU: o prompt diz que o horário não vale, e não o confirma', () => {
  const bloco = renderConsultaMarcada(
    { idSchedule: 1, quando: '2026-11-04T14:00', salvo: '2026-11-04T14:00', estado: 'cancelada', mudou: false, especialista: null, idStatus: SPINE_STATUS.NAO_COMPARECEU },
    '2026-10-22T08:33:00',
    null,
  );
  assert.match(bloco, /NÃO COMPARECEU na consulta de 04\/11\/2026 às 14:00/);
  assert.match(bloco, /NÃO vale mais/);
  assert.doesNotMatch(bloco, /CONFIRMADA/);
});

test('desmarcada continua com o texto de desmarcada', () => {
  const bloco = renderConsultaMarcada(
    { idSchedule: 1, quando: null, salvo: '2026-11-04T14:00', estado: 'cancelada', mudou: true, especialista: null, idStatus: SPINE_STATUS.DESMARCADO },
    '2026-10-22T08:33:00',
    null,
  );
  assert.match(bloco, /DESMARCADA/);
});

test('a consulta vinculada que virou NÃO COMPARECEU sai como cancelada (não como confirmada)', async () => {
  const { prisma } = await import('../lib/prisma.js');
  const { SpineService } = await import('./spine.service.js');
  const { consultaDoLead } = await import('./agenda-reconcile.service.js');
  const linkAntes = Object.getOwnPropertyDescriptor(prisma, 'spineLeadLink');
  const buscaAntes = SpineService.searchSchedules;
  Object.defineProperty(prisma, 'spineLeadLink', {
    value: { findFirst: async () => ({ id: 'l1', spineIdSchedule: 3790682, agendadoPara: '2026-11-04T14:00', spineIdClient: 371384 }), update: async () => ({}) },
    configurable: true,
  });
  (SpineService as unknown as Record<string, unknown>).searchSchedules = async () => ({
    ok: true,
    data: { schedules: [{ idSchedule: 3790682, idStatus: SPINE_STATUS.NAO_COMPARECEU, dayLocal: '2026-11-04', timeLocal: '14:00', physicalTherapist: null }] },
  });
  try {
    const unit = { id: 'u-beb', slug: 'doutor-hernia-bebedouro', spineEnabled: true, spineToken: 'tok', spineTimezone: 'America/Sao_Paulo' } as never;
    const c = await consultaDoLead(unit, 6525111);
    assert.equal(c?.estado, 'cancelada');
    assert.equal(c?.idStatus, SPINE_STATUS.NAO_COMPARECEU);
    assert.equal(c?.quando, '2026-11-04T14:00');
  } finally {
    if (linkAntes) Object.defineProperty(prisma, 'spineLeadLink', linkAntes);
    (SpineService as unknown as Record<string, unknown>).searchSchedules = buscaAntes;
  }
});
