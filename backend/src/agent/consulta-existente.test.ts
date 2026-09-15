import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avisoDeConsultaExistente,
  consultasFuturas,
  formatarQuando,
  type AgendamentoDoPaciente,
} from './consulta-existente.js';

const TZ = 'America/Sao_Paulo';
const AGORA = new Date('2026-09-15T15:10:00Z'); // 12:10 em São Paulo — a hora do caso Wilson

const s = (
  dateAttendanceUtc: string | null,
  idStatus = 37,
  categoryName = 'RETORNO',
  idSchedule = 1,
): AgendamentoDoPaciente => ({ idSchedule, dateAttendanceUtc, categoryName, idStatus, statusName: 'AGENDADO' });

test('o caso Wilson: a consulta dele de hoje 14h30 é encontrada', () => {
  // A franquia devolve UTC: 17:30Z = 14:30 em São Paulo.
  const c = consultasFuturas([s('2026-09-15T17:30:00.000Z')], AGORA);
  assert.equal(c.length, 1);
  assert.match(formatarQuando(c[0].quandoMs, TZ), /14:30/);
});

test('fuso: renderiza em hora LOCAL, nunca em UTC', () => {
  // Foi renderizando em UTC que eu "conferi" três vezes e me enganei três vezes.
  const c = consultasFuturas([s('2026-09-17T19:00:00.000Z')], AGORA);
  const t = formatarQuando(c[0].quandoMs, TZ);
  assert.match(t, /16:00/);
  assert.doesNotMatch(t, /19:00/);
});

test('desmarcado não conta — o horário voltou para a agenda', () => {
  assert.equal(consultasFuturas([s('2026-09-17T19:00:00.000Z', 57)], AGORA).length, 0);
});

test('consulta que já passou não conta', () => {
  assert.equal(consultasFuturas([s('2026-09-10T17:30:00.000Z')], AGORA).length, 0);
});

test('sem data não conta e não quebra', () => {
  assert.equal(consultasFuturas([s(null)], AGORA).length, 0);
  assert.equal(consultasFuturas(null, AGORA).length, 0);
  assert.equal(consultasFuturas(undefined, AGORA).length, 0);
});

test('a mais próxima vem primeiro', () => {
  const c = consultasFuturas(
    [s('2026-09-20T17:00:00.000Z', 37, 'SESSÃO', 2), s('2026-09-16T13:00:00.000Z', 37, 'RETORNO', 1)],
    AGORA,
  );
  assert.deepEqual(c.map((x) => x.idSchedule), [1, 2]);
});

test('o aviso PROÍBE agendar de novo — não basta informar', () => {
  const c = consultasFuturas([s('2026-09-15T17:30:00.000Z')], AGORA);
  const t = avisoDeConsultaExistente('WILSON DELFINO DOS SANTOS', 999, c, TZ);
  assert.match(t, /NÃO chame agendar_consulta/);
  assert.match(t, /remarcar_consulta/);
  assert.match(t, /14:30/);
  assert.match(t, /idClient 999/);
});

test('o aviso avisa que o horário ocupado pode ser o do próprio paciente', () => {
  // Foi o que a Sofia disse ao Wilson: que as 14h30 dele estavam tomadas.
  const c = consultasFuturas([s('2026-09-15T17:30:00.000Z')], AGORA);
  const t = avisoDeConsultaExistente('Wilson', 1, c, TZ);
  assert.match(t, /porque é dele/);
});

test('divergência de horário vai para a equipe, não vira negociação', () => {
  const c = consultasFuturas([s('2026-09-15T17:30:00.000Z')], AGORA);
  const t = avisoDeConsultaExistente('Wilson', 1, c, TZ);
  assert.match(t, /passe para a equipe/);
});

test('mais de uma consulta: o texto concorda no plural e lista todas', () => {
  const c = consultasFuturas(
    [s('2026-09-16T13:00:00.000Z', 37, 'RETORNO', 1), s('2026-09-20T17:00:00.000Z', 37, 'SESSÃO', 2)],
    AGORA,
  );
  const t = avisoDeConsultaExistente('Wilson', 1, c, TZ);
  assert.match(t, /2 consultas marcadas/);
  // só as linhas de consulta (as de orientação também começam com "•")
  assert.equal((t.match(/^• .*\d{2}\/\d{2}.*\d{2}:\d{2}/gm) ?? []).length, 2);
  assert.match(t, /RETORNO/);
  assert.match(t, /SESSÃO/);
});
