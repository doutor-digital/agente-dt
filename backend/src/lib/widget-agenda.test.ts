import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chaveConfere, chaveDoWidget, resumoDaAgenda } from './widget-agenda.js';
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';

function ag(p: Partial<SpineSchedule> & { dateAttendanceUtc: string }): SpineSchedule {
  return {
    idSchedule: 1,
    idTreatment: null,
    idStatus: SPINE_STATUS.AGENDADO,
    statusName: 'AGENDADO',
    clientName: 'Maria',
    categoryName: 'Avaliação',
    physicalTherapist: 'Dra. Ana',
    dateAttendanceLocal: null,
    dayLocal: p.dateAttendanceUtc.slice(0, 10),
    timeLocal: p.dateAttendanceUtc.slice(11, 16),
    isBusy: true,
    requiresManualValidation: false,
    ...p,
  };
}

const AGORA = new Date('2026-09-16T12:00:00Z');

describe('chaveDoWidget', () => {
  it('é estável por slug e confere só com a chave certa', () => {
    const k = chaveDoWidget('doutor-hernia-imperatriz', 'segredo-de-teste-com-mais-de-32-caracteres');
    assert.equal(k.length, 24);
    assert.equal(k, chaveDoWidget('doutor-hernia-imperatriz', 'segredo-de-teste-com-mais-de-32-caracteres'));
    assert.notEqual(k, chaveDoWidget('doutor-hernia-balsas', 'segredo-de-teste-com-mais-de-32-caracteres'));
    assert.ok(chaveConfere('doutor-hernia-imperatriz', 'segredo-de-teste-com-mais-de-32-caracteres', k));
    assert.ok(!chaveConfere('doutor-hernia-imperatriz', 'segredo-de-teste-com-mais-de-32-caracteres', k.slice(0, 23) + 'x'));
    assert.ok(!chaveConfere('doutor-hernia-imperatriz', 'segredo-de-teste-com-mais-de-32-caracteres', undefined));
  });
});

describe('resumoDaAgenda', () => {
  it('separa consulta futura de pé, última consulta passada e sessões', () => {
    const r = resumoDaAgenda(
      [
        ag({ idSchedule: 10, dateAttendanceUtc: '2026-09-18T14:00:00Z', categoryName: 'Avaliação', idStatus: SPINE_STATUS.CONFIRMADO, statusName: 'CONFIRMADO' }),
        ag({ idSchedule: 11, dateAttendanceUtc: '2026-09-01T14:00:00Z', categoryName: 'Avaliação', idStatus: SPINE_STATUS.ATENDIDO, statusName: 'ATENDIDO' }),
        ag({ idSchedule: 12, dateAttendanceUtc: '2026-09-10T10:00:00Z', categoryName: 'Sessão', idStatus: SPINE_STATUS.ATENDIDO, statusName: 'ATENDIDO' }),
        ag({ idSchedule: 13, dateAttendanceUtc: '2026-09-12T10:00:00Z', categoryName: 'Sessão', idStatus: SPINE_STATUS.NAO_COMPARECEU, statusName: 'NÃO COMPARECEU' }),
        ag({ idSchedule: 14, dateAttendanceUtc: '2026-09-17T10:00:00Z', categoryName: 'Sessão', idStatus: SPINE_STATUS.AGENDADO }),
      ],
      AGORA,
    );
    assert.equal(r.proximaConsulta?.idSchedule, 10);
    assert.equal(r.proximaConsulta?.dia, '18/09');
    assert.equal(r.proximaConsulta?.hora, '14:00');
    assert.equal(r.ultimaConsulta?.idSchedule, 11);
    assert.equal(r.proximaSessao?.idSchedule, 14);
    assert.equal(r.ultimaSessao?.idSchedule, 13);
    assert.deepEqual(r.sessoes, { realizadas: 1, faltas: 1, futuras: 1 });
    assert.equal(r.temConsultaFutura, true);
    assert.equal(r.consultas.length, 2);
    assert.equal(r.consultas[0].idSchedule, 10, 'consultas vêm da mais nova pra mais velha');
  });

  it('consulta futura DESMARCADA não conta como marcada (é o caso do cartão que diz Agendado e a franquia diz Desmarcado)', () => {
    const r = resumoDaAgenda([ag({ idSchedule: 20, dateAttendanceUtc: '2026-09-20T14:00:00Z', idStatus: SPINE_STATUS.DESMARCADO, statusName: 'DESMARCADO' })], AGORA);
    assert.equal(r.proximaConsulta, null);
    assert.equal(r.temConsultaFutura, false);
    assert.equal(r.consultas[0].status, 'DESMARCADO', 'mas ela continua listada, pra SDR ver o que aconteceu');
  });

  it('ignora agendamento sem data e não quebra com lista vazia', () => {
    assert.equal(resumoDaAgenda([], AGORA).proximaConsulta, null);
    const r = resumoDaAgenda([{ ...ag({ dateAttendanceUtc: '2026-09-18T14:00:00Z' }), dateAttendanceUtc: null }], AGORA);
    assert.equal(r.consultas.length, 0);
  });
});
