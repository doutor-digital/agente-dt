import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proximaSessao } from './proxima-sessao.js';

const AGORA = Date.parse('2026-09-19T11:00:00Z');
const s = (utc: string, idStatus: number) => ({
  dateAttendanceUtc: utc,
  dateAttendanceLocal: utc.replace('Z', '').replace(/T(\d{2})/, (_m, h) => `T${String(Number(h) - 3).padStart(2, '0')}`),
  idStatus,
});

// A agenda real do Fabio Sousa Santos (Imperatriz) no dia do incidente.
const FABIO = [
  s('2026-08-29T12:00:00.000Z', 42),
  s('2026-09-15T15:00:00.000Z', 42),
  s('2026-09-17T15:30:00.000Z', 42),
  s('2026-09-19T15:00:00.000Z', 57), // desmarcada
  s('2026-09-23T11:00:00.000Z', 41), // remarcada — é esta a próxima
];

test('REMARCADO conta como próxima sessão', () => {
  const p = proximaSessao(FABIO, AGORA);
  assert.equal(p?.dateAttendanceUtc, '2026-09-23T11:00:00.000Z');
});

test('DESMARCADO nunca é a próxima — a vaga voltou pra agenda', () => {
  const p = proximaSessao([s('2026-09-19T15:00:00.000Z', 57)], AGORA);
  assert.equal(p, null);
});

test('AGENDADO e CONFIRMADO continuam valendo', () => {
  assert.equal(proximaSessao([s('2026-09-20T12:00:00.000Z', 37)], AGORA)?.idStatus, 37);
  assert.equal(proximaSessao([s('2026-09-20T12:00:00.000Z', 38)], AGORA)?.idStatus, 38);
});

test('entre várias futuras, a mais próxima ganha', () => {
  const p = proximaSessao(
    [s('2026-09-30T12:00:00.000Z', 37), s('2026-09-22T12:00:00.000Z', 41), s('2026-09-25T12:00:00.000Z', 38)],
    AGORA,
  );
  assert.equal(p?.dateAttendanceUtc, '2026-09-22T12:00:00.000Z');
});

test('sessão passada não é próxima, mesmo agendada', () => {
  assert.equal(proximaSessao([s('2026-09-18T12:00:00.000Z', 37)], AGORA), null);
});

test('status desconhecido não vira data no cartão', () => {
  // dessa data sai a mensagem de véspera; não carimbo o que não sei ler
  assert.equal(proximaSessao([s('2026-09-22T12:00:00.000Z', 99)], AGORA), null);
  assert.equal(proximaSessao([{ dateAttendanceUtc: '2026-09-22T12:00:00.000Z', idStatus: null }], AGORA), null);
});

test('ATENDIDO no futuro não conta (dado torto da franquia)', () => {
  assert.equal(proximaSessao([s('2026-09-22T12:00:00.000Z', 42)], AGORA), null);
});
