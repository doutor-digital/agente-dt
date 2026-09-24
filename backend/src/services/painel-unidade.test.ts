import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contarSumindo } from './painel-unidade.service.js';
import type { SpineSchedule } from './spine.service.js';

function sessao(dia: string, status: string, nome = 'MARIA'): SpineSchedule {
  return {
    idSchedule: Math.floor(Math.random() * 1e6),
    idTreatment: 1,
    idStatus: null,
    statusName: status,
    clientName: nome,
    categoryName: 'SESSÃO',
    physicalTherapist: null,
    dateAttendanceUtc: `${dia}T12:00:00.000Z`,
    dateAttendanceLocal: `${dia} 09:00`,
    dayLocal: dia,
    timeLocal: '09:00',
    isBusy: true,
    requiresManualValidation: false,
  };
}

const HOJE = '2026-09-24';

test('conta as faltas seguidas a partir da sessão mais recente', () => {
  const r = contarSumindo(
    [
      sessao('2026-09-01', 'ATENDIDO'),
      sessao('2026-09-08', 'ATENDIDO'),
      sessao('2026-09-15', 'DESMARCADO'),
      sessao('2026-09-22', 'DESMARCADO'),
    ],
    HOJE,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].faltasSeguidas, 2);
  assert.equal(r[0].feitas, 2);
  assert.equal(r[0].total, 4);
  assert.equal(r[0].ultimaFalta, '2026-09-22');
});

test('quem voltou a comparecer sai da lista — a sequência quebra', () => {
  const r = contarSumindo(
    [
      sessao('2026-09-01', 'DESMARCADO'),
      sessao('2026-09-08', 'DESMARCADO'),
      sessao('2026-09-15', 'ATENDIDO'),
    ],
    HOJE,
  );
  assert.deepEqual(r, [], 'faltou duas vezes mas voltou: não está sumindo');
});

test('REMARCADO não conta como falta nem quebra a sequência', () => {
  // clínica que remarca série inteira não pode virar lista falsa de abandono
  const r = contarSumindo(
    [
      sessao('2026-09-01', 'ATENDIDO'),
      sessao('2026-09-08', 'REMARCADO'),
      sessao('2026-09-15', 'DESMARCADO'),
      sessao('2026-09-18', 'REMARCADO'),
      sessao('2026-09-22', 'DESMARCADO'),
    ],
    HOJE,
  );
  assert.equal(r[0].faltasSeguidas, 2);
});

test('sessão futura não conta como falta', () => {
  const r = contarSumindo(
    [
      sessao('2026-09-22', 'DESMARCADO'),
      sessao('2026-09-30', 'AGENDADO'),
      sessao('2026-10-05', 'AGENDADO'),
    ],
    HOJE,
  );
  assert.deepEqual(r, [], 'uma falta só, e o resto ainda vai acontecer');
});

test('uma falta só não entra (o mínimo é 2)', () => {
  const r = contarSumindo([sessao('2026-09-01', 'ATENDIDO'), sessao('2026-09-22', 'DESMARCADO')], HOJE);
  assert.deepEqual(r, []);
});

test('avaliação não entra: a lista é de quem está EM TRATAMENTO', () => {
  const av = sessao('2026-09-22', 'DESMARCADO');
  const r = contarSumindo([{ ...av, categoryName: 'AVALIAÇÃO' }, { ...av, categoryName: 'AVALIAÇÃO' }], HOJE);
  assert.deepEqual(r, []);
});

test('ordena do pior pro menos pior', () => {
  const r = contarSumindo(
    [
      sessao('2026-09-15', 'DESMARCADO', 'ANA'),
      sessao('2026-09-22', 'DESMARCADO', 'ANA'),
      sessao('2026-09-01', 'DESMARCADO', 'BENTO'),
      sessao('2026-09-08', 'DESMARCADO', 'BENTO'),
      sessao('2026-09-15', 'DESMARCADO', 'BENTO'),
      sessao('2026-09-22', 'DESMARCADO', 'BENTO'),
    ],
    HOJE,
  );
  assert.equal(r[0].nome, 'BENTO');
  assert.equal(r[0].faltasSeguidas, 4);
  assert.equal(r[1].nome, 'ANA');
});
