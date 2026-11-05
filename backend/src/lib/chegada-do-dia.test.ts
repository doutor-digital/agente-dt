/**
 * Os atendimentos do paciente no dia — o caso real que motivou (Açailândia, 03/11/2026, cartão 24830668):
 * Maria Aparecida (idClient 353493) tem DOIS tratamentos, 125336 e 125337, com sessões em sequência no mesmo dia —
 * 03/11, 06/11 e 09/11, sempre 15h30 (125336) e 16h (125337). O cartão guarda o idTreatment 125337 e a
 * «◷ Próxima sessão» 1793732400 (03/11 16:00): a resposta ao "Confirmar presença" falava 16h, e a paciente
 * chegava meia hora atrasada para a primeira sessão.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import {
  atendimentosDePeNoDia,
  diaComVariosAtendimentos,
  gruposDoDia,
  horaFalada,
  horariosDistintos,
  listaDeHorarios,
} from './chegada-do-dia.js';

const A = SPINE_STATUS.AGENDADO;
const C = SPINE_STATUS.CONFIRMADO;
const ATENDIDO = SPINE_STATUS.ATENDIDO;

/** Açailândia é UTC-3 o ano todo. `hora` local → o instante UTC. */
const epoch = (dia: string, hora: string): number => Math.floor(Date.parse(`${dia}T${hora}:00-03:00`) / 1000);

let seq = 3_000_000;
function atendimento(dia: string, hora: string, trat: number | null, status: number, over: Partial<SpineSchedule> = {}): SpineSchedule {
  const utc = new Date(epoch(dia, hora) * 1000).toISOString();
  return {
    idSchedule: seq++, idTreatment: trat, idStatus: status, statusName: null,
    clientName: 'MARIA APARECIDA', categoryName: 'PROTOCOLO 03 MESES - CERVICAL', physicalTherapist: null,
    dateAttendanceUtc: utc, dateAttendanceLocal: `${dia}T${hora}:00`, dayLocal: dia, timeLocal: hora,
    isBusy: true, requiresManualValidation: false, ...over,
  };
}

/** A paciente do caso real: 03/11 15:30 ATENDIDO + 16:00 CONFIRMADO; 06/11 e 09/11 15:30 e 16:00 AGENDADO. */
function maria(): SpineSchedule[] {
  return [
    atendimento('2026-11-03', '15:30', 125336, ATENDIDO),
    atendimento('2026-11-03', '16:00', 125337, C),
    atendimento('2026-11-06', '15:30', 125336, A),
    atendimento('2026-11-06', '16:00', 125337, A),
    atendimento('2026-11-09', '15:30', 125336, A),
    atendimento('2026-11-09', '16:00', 125337, A),
  ];
}
const RETORNO = { categoryName: 'Retorno após tratamento' };

test('texto dos horários: como a recepção escreve', () => {
  assert.equal(horaFalada('15:30'), '15h30');
  assert.equal(horaFalada('16:00'), '16h');
  assert.equal(horaFalada('09:05'), '9h05');
  assert.equal(listaDeHorarios(['15:30', '16:00']), '15h30 e 16h');
  assert.equal(listaDeHorarios(['15:30', '16:00', '16:30']), '15h30, 16h e 16h30');
  assert.equal(listaDeHorarios(['16:00']), '16h');
});

test('CASO REAL, dia 06/11: os dois atendimentos de pé, a chegada é 15h30', () => {
  const v = diaComVariosAtendimentos(maria(), '2026-11-06')!;
  assert.deepEqual(v.horarios, ['15:30', '16:00']);
  assert.equal(v.chegada, '15:30');
  assert.equal(v.atendimentos.length, 2);
});

test('dia com uma sessão só: nada de "vários"', () => {
  assert.equal(diaComVariosAtendimentos([atendimento('2026-11-09', '16:00', 125337, A)], '2026-11-09'), null);
});

test('desmarcado no meio: sessão desmarcada ou remarcada nunca conta; o que sobra é um só', () => {
  const s = [
    atendimento('2026-11-06', '15:30', 125336, SPINE_STATUS.DESMARCADO),
    atendimento('2026-11-06', '16:00', 125337, A),
    atendimento('2026-11-06', '16:30', 125337, SPINE_STATUS.REMARCADO),
  ];
  assert.deepEqual(horariosDistintos(atendimentosDePeNoDia(s, '2026-11-06')), ['16:00']);
  assert.equal(diaComVariosAtendimentos(s, '2026-11-06'), null);
});

test('QUEM TOCA ÀS 15h45: o que já passou não entra — "chegue às 15h30" e sessão passada nunca saem', () => {
  const s = [atendimento('2026-11-06', '15:30', 125336, A), atendimento('2026-11-06', '16:00', 125337, A), atendimento('2026-11-06', '16:30', 125337, A)];
  const agora = epoch('2026-11-06', '15:45');
  const v = diaComVariosAtendimentos(s, '2026-11-06', agora)!;
  assert.deepEqual(v.horarios, ['16:00', '16:30']);
  assert.equal(v.chegada, '16:00');
  // só o 16:00 por vir: um só, a mensagem é a de sempre
  assert.equal(diaComVariosAtendimentos(s.slice(0, 2), '2026-11-06', agora), null);
  // o instante exato do atendimento já é "começou"
  assert.deepEqual(horariosDistintos(atendimentosDePeNoDia(s, '2026-11-06', epoch('2026-11-06', '16:00'))), ['16:30']);
  // sem `aPartirDe` o dia inteiro, como antes
  assert.equal(atendimentosDePeNoDia(s, '2026-11-06').length, 3);
});

test('o mesmo agendamento vindo da agenda E da ficha conta uma vez; dois no mesmo horário são um horário', () => {
  const a = atendimento('2026-11-06', '15:30', 125336, A);
  assert.equal(atendimentosDePeNoDia([a, { ...a }], '2026-11-06').length, 1);
  const mesmaHora = [atendimento('2026-11-06', '15:30', 125336, A), atendimento('2026-11-06', '15:30', 125337, A)];
  assert.deepEqual(horariosDistintos(mesmaHora), ['15:30']);
  // dois agendamentos, um horário só: o dia inteiro é confirmado, mas o texto não vira "15h30 e 15h30"
  const v = diaComVariosAtendimentos(mesmaHora, '2026-11-06')!;
  assert.equal(v.atendimentos.length, 2);
  assert.deepEqual(v.horarios, ['15:30']);
});

test('avaliação/retorno no mesmo dia da sessão entra no dia; os grupos separam o que o lembrete anunciou do resto', () => {
  const retorno = atendimento('2026-11-10', '15:00', null, A, RETORNO);
  const sessao = atendimento('2026-11-10', '15:30', 125336, A);
  const v = diaComVariosAtendimentos([retorno, sessao], '2026-11-10')!;
  assert.equal(v.chegada, '15:00');
  const g = gruposDoDia(v, 'sessao');
  assert.deepEqual(g.iguais.map((x) => x.idSchedule), [sessao.idSchedule]);
  assert.deepEqual(g.outros.map((x) => x.idSchedule), [retorno.idSchedule]);
  const h = gruposDoDia(v, 'consulta');
  assert.deepEqual(h.iguais.map((x) => x.idSchedule), [retorno.idSchedule]);
});

test('agendamento sem data legível ou sem status não entra', () => {
  const sem = atendimento('2026-11-06', '15:30', 125336, A, { dateAttendanceUtc: null });
  const semStatus = atendimento('2026-11-06', '16:00', 125337, A, { idStatus: null });
  assert.deepEqual(atendimentosDePeNoDia([sem, semStatus], '2026-11-06'), []);
});
