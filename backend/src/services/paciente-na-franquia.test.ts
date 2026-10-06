import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nadaADizer, resumirPaciente } from './paciente-na-franquia.js';
import { renderPacienteNaFranquia } from '../agent/prompt-composer.js';
import { SPINE_STATUS, type SpineSchedule } from './spine.service.js';

function ag(dia: string, hora: string, idStatus: number, categoryName: string, physicalTherapist: string | null = null): SpineSchedule {
  return {
    idSchedule: Math.floor(Math.random() * 1e6),
    idTreatment: null,
    idStatus,
    statusName: null,
    clientName: 'PAULO SERGIO DA SILVA',
    categoryName,
    physicalTherapist,
    dateAttendanceUtc: null,
    dateAttendanceLocal: `${dia}T${hora}:00`,
    dayLocal: dia,
    timeLocal: hora,
    isBusy: true,
    requiresManualValidation: false,
  };
}

// O caso que originou: Taubaté, lead 4851114. A recepção marcou a avaliação de 05/10 às 19:30, ele
// foi atendido e fechou tratamento; na manhã de 06/10 a Sofia pediu que confirmasse "amanhã, 06/10, 7h".
const AGORA_PAULO = '2026-10-06T09:26:00';
const HISTORICO_PAULO = [
  ag('2026-10-05', '19:30', SPINE_STATUS.ATENDIDO, 'AVALIACAO', 'DRA. MARIANE GOMES'),
  ag('2026-10-08', '18:00', SPINE_STATUS.AGENDADO, 'SESSAO', 'DRA. MARIANE GOMES'),
  ag('2026-10-13', '18:00', SPINE_STATUS.AGENDADO, 'SESSAO', 'DRA. MARIANE GOMES'),
];

test('paciente na franquia: o caso do Paulo — em tratamento, avaliação atendida, próxima sessão', () => {
  const p = resumirPaciente(365001, HISTORICO_PAULO, [{ idStatus: 45, statusName: 'Em andamento' }], AGORA_PAULO);
  assert.equal(p.emTratamento, true);
  assert.equal(p.ultimaConsultaAtendida?.quando, '2026-10-05T19:30');
  assert.equal(p.ultimaConsultaAtendida?.consulta, true);
  assert.equal(p.proximo?.quando, '2026-10-08T18:00', 'a mais próxima, não a última');
  assert.equal(p.proximo?.consulta, false, 'sessão não é consulta');
});

test('paciente na franquia: o bloco do Paulo proíbe oferecer avaliação e repetir horário do histórico', () => {
  const p = resumirPaciente(365001, HISTORICO_PAULO, [{ idStatus: 45, statusName: 'Em andamento' }], AGORA_PAULO);
  const bloco = renderPacienteNaFranquia(p);
  assert.match(bloco, /<consulta_do_paciente>/);
  assert.match(bloco, /JÁ TEM TRATAMENTO/);
  assert.match(bloco, /avaliação em 05\/10\/2026 às 19:30/);
  assert.match(bloco, /sessão de tratamento em \*\*08\/10\/2026 às 18:00\*\*/);
  assert.match(bloco, /NÃO ofereça avaliação/);
  assert.match(bloco, /nunca peça para confirmar/);
});

test('paciente na franquia: agendado no passado e desmarcado não contam como próximo', () => {
  const p = resumirPaciente(
    1,
    [
      ag('2026-10-05', '07:00', SPINE_STATUS.AGENDADO, 'AVALIACAO'), // ninguém deu baixa, mas já passou
      ag('2026-10-09', '08:00', SPINE_STATUS.DESMARCADO, 'AVALIACAO'),
      ag('2026-10-10', '08:00', SPINE_STATUS.CONFIRMADO, 'AVALIACAO', 'DRA. JULIANA SANTOS'),
    ],
    [],
    AGORA_PAULO,
  );
  assert.equal(p.proximo?.quando, '2026-10-10T08:00');
  assert.equal(p.proximo?.consulta, true);
  assert.equal(p.emTratamento, false);
  assert.equal(p.ultimaConsultaAtendida, null);
  const bloco = renderPacienteNaFranquia(p);
  assert.match(bloco, /avaliação em \*\*10\/10\/2026 às 08:00\*\*/);
  assert.match(bloco, /REMARCAR/);
  assert.doesNotMatch(bloco, /NÃO ofereça avaliação/, 'quem ainda não foi atendido pode ouvir sobre a avaliação');
});

test('paciente na franquia: sessão atendida não é "consulta atendida"', () => {
  const p = resumirPaciente(1, [ag('2026-10-01', '10:00', SPINE_STATUS.ATENDIDO, 'SESSAO')], [], AGORA_PAULO);
  assert.equal(p.ultimaConsultaAtendida, null);
});

test('paciente na franquia: sem nada a dizer, sem bloco', () => {
  const p = resumirPaciente(1, [ag('2026-10-09', '08:00', SPINE_STATUS.DESMARCADO, 'AVALIACAO')], [], AGORA_PAULO);
  assert.equal(nadaADizer(p), true);
  assert.equal(renderPacienteNaFranquia(p), '');
  assert.equal(renderPacienteNaFranquia(null), '');
});

test('paciente na franquia: tratamento finalizado não é "em tratamento"', () => {
  const p = resumirPaciente(1, [], [{ idStatus: 46, statusName: 'Finalizado' }], AGORA_PAULO);
  assert.equal(p.emTratamento, false);
});

test('paciente na franquia: avaliação atendida há mais de 90 dias não trava a avaliação nova', () => {
  const antiga = resumirPaciente(1, [ag('2024-05-10', '10:00', SPINE_STATUS.ATENDIDO, 'AVALIACAO')], [{ idStatus: 46, statusName: 'Finalizado' }], AGORA_PAULO);
  assert.equal(antiga.ultimaConsultaAtendida, null, 'ex-paciente de 2024 com dor nova é lead de novo');
  assert.equal(renderPacienteNaFranquia(antiga), '');
  const recente = resumirPaciente(1, [ag('2026-07-10', '10:00', SPINE_STATUS.ATENDIDO, 'AVALIACAO')], [], AGORA_PAULO);
  assert.equal(recente.ultimaConsultaAtendida?.quando, '2026-07-10T10:00', '88 dias atrás ainda conta');
});
