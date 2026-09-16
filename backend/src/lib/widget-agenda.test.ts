import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chaveConfere, chaveDoWidget, janelaDoPeriodo, janelaExplicita, limparNome, resumirAuditoria, resumoDaAgenda, termosDeBusca } from './widget-agenda.js';
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

describe('limparNome / termosDeBusca', () => {
  it('tira a data do fim do nome (padrão da casa) e o "Lead #123"', () => {
    assert.equal(limparNome('Sandra da Cruz 27/5/26'), 'Sandra da Cruz');
    assert.equal(limparNome('Sandra Maria da Cruz Chaves 03/08/2026'), 'Sandra Maria da Cruz Chaves');
    assert.equal(limparNome('ROSANGELA 04/09'), 'ROSANGELA');
    assert.equal(limparNome('Lead #26180289'), '');
    assert.equal(limparNome(null), '');
  });
  it('gera os termos do mais específico pro mais largo, sem repetir', () => {
    assert.deepEqual(termosDeBusca('Sandra Maria da Cruz Chaves 03/08/2026', 'Sandra da Cruz 27/5/26'), [
      'Sandra Maria da Cruz Chaves', 'Sandra da Cruz', 'Sandra Chaves', 'Sandra', 'Sandra Cruz',
    ]);
    assert.deepEqual(termosDeBusca('Lead #1', 'Jo'), [], 'nada com menos de 3 letras');
  });
});

describe('janelaDoPeriodo (Números da unidade)', () => {
  const TZ = 'America/Sao_Paulo';
  it('hoje = o dia local, mesmo quando em UTC já virou o dia seguinte', () => {
    // 16/09 23:30 em São Paulo = 17/09 02:30 UTC
    const j = janelaDoPeriodo('hoje', new Date('2026-09-17T02:30:00Z'), TZ);
    assert.deepEqual(j, { tipo: 'hoje', de: '2026-09-16', ate: '2026-09-16' });
  });
  it('semana começa na segunda; mês começa no dia 1; período desconhecido vira hoje', () => {
    const agora = new Date('2026-09-16T15:00:00Z');   // quarta-feira
    assert.deepEqual(janelaDoPeriodo('semana', agora, TZ), { tipo: 'semana', de: '2026-09-14', ate: '2026-09-16' });
    assert.deepEqual(janelaDoPeriodo('mes', agora, TZ), { tipo: 'mes', de: '2026-09-01', ate: '2026-09-16' });
    assert.equal(janelaDoPeriodo('xx', agora, TZ).tipo, 'hoje');
    // segunda-feira: a semana é só ela mesma
    assert.deepEqual(janelaDoPeriodo('semana', new Date('2026-09-14T15:00:00Z'), TZ), { tipo: 'semana', de: '2026-09-14', ate: '2026-09-14' });
  });
});

describe('janelaExplicita', () => {
  it('aceita de/ate válidos até 92 dias e recusa o resto', () => {
    assert.deepEqual(janelaExplicita('2026-09-01', '2026-09-15'), { tipo: 'custom', de: '2026-09-01', ate: '2026-09-15' });
    assert.equal(janelaExplicita('2026-09-15', '2026-09-01'), null, 'fim antes do começo');
    assert.equal(janelaExplicita('2026-01-01', '2026-06-01'), null, 'mais de 92 dias');
    assert.equal(janelaExplicita('16/09/2026', '16/09/2026'), null, 'formato errado');
    assert.equal(janelaExplicita(undefined, undefined), null);
  });
});

describe('resumirAuditoria', () => {
  it('achata os blocos do dashboard, dá título em português e corta a lista nominal', () => {
    const r = resumirAuditoria({
      totalDivergencias: 3,
      blocos: [{
        kpi: 'agendamentos', fonte: 'CRM (Kommo)', numero: 89, conferencia: 9, leitura: '2 cartões sem carimbo',
        cobertura: { total: 3, legiveis: 2, nota: 'x', percentual: 66 },
        quebra: [{ rotulo: 'Com pagamento antecipado', quantidade: 0 }, { rotulo: 'Sem', quantidade: 89, valor: null }],
        divergentes: [{ leadId: 1, nome: 'A', motivo: 'm1' }, { leadId: 2, nome: 'B', motivo: 'm2' }, { leadId: 3, nome: 'C', motivo: 'm3' }],
      }],
    }, 2);
    assert.equal(r.totalDivergencias, 3);
    assert.equal(r.numeros[0].titulo, 'Agendamentos');
    assert.equal(r.numeros[0].cobertura?.percentual, 66);
    assert.deepEqual(r.numeros[0].divergentes, [{ nome: 'A', motivo: 'm1' }, { nome: 'B', motivo: 'm2' }]);
    assert.equal(r.numeros[0].maisDivergentes, 1);
    assert.ok(!('leadId' in r.numeros[0].divergentes[0]), 'id interno do dashboard não vaza pro widget');
  });
  it('não quebra com resposta vazia', () => {
    assert.deepEqual(resumirAuditoria(null), { totalDivergencias: 0, numeros: [] });
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
