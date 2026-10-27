import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { conferenciaDaFranquia, type FranquiaPorta } from './disparo/franquia.js';
import { SPINE_STATUS } from '../services/spine.service.js';

const AGORA = new Date(Date.UTC(2026, 9, 26, 15));
const UNIT = { id: 'u1', slug: 'doutor-hernia-canaa', spineToken: 'tok', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
const PESSOA = { leadId: 10, nomeCompleto: 'Maria da Silva', telefone: '5563991021043' };

type Sch = { clientName: string | null; dateAttendanceUtc: string | null; idStatus: number | null };
type Tr = { clientName: string | null; statusName: string | null };

/** Uma franquia de mentira: cada teste liga só o que quer e o resto responde "nada". */
function franquia(o: {
  agenda?: Sch[] | 'falha' | 'lanca';
  tratamentos?: Tr[] | 'falha';
  agendaTruncada?: boolean;
  tratamentosTruncada?: boolean;
  idClient?: number | null;
  ficha?: { schedules: Sch[]; treatments: Array<{ idStatus: number | null; statusName: string | null }> } | 'falha' | 'lanca';
} = {}) {
  const chamadas = { agenda: 0, tratamentos: 0, ficha: 0, idClient: 0 };
  const porta: FranquiaPorta = {
    searchSchedules: (async () => {
      chamadas.agenda++;
      if (o.agenda === 'lanca') throw new Error('boom');
      if (o.agenda === 'falha') return { ok: false, error: 'fora do ar' };
      return { ok: true, data: { schedules: o.agenda ?? [], pages: 1, total: 0, truncada: o.agendaTruncada } };
    }) as unknown as FranquiaPorta['searchSchedules'],
    searchTreatments: (async () => {
      chamadas.tratamentos++;
      if (o.tratamentos === 'falha') return { ok: false, error: 'fora do ar' };
      return { ok: true, data: { treatments: o.tratamentos ?? [], truncada: o.tratamentosTruncada } };
    }) as unknown as FranquiaPorta['searchTreatments'],
    idClientDoLead: (async () => {
      chamadas.idClient++;
      return o.idClient === undefined ? null : o.idClient;
    }) as unknown as FranquiaPorta['idClientDoLead'],
    getClient: (async () => {
      chamadas.ficha++;
      if (o.ficha === 'lanca') throw new Error('boom');
      if (o.ficha === 'falha') return { ok: false, error: 'fora do ar' };
      return { ok: true, data: { client: o.ficha ?? { schedules: [], treatments: [] } } };
    }) as unknown as FranquiaPorta['getClient'],
  };
  return { porta, chamadas };
}
const confere = (unit: Unit, f: ReturnType<typeof franquia>, p: { leadId: number | null; nomeCompleto: string; telefone: string } = PESSOA) => conferenciaDaFranquia(unit, () => AGORA, f.porta)(p);
const amanha = '2026-10-27T15:00:00Z';
const ontem = '2026-10-25T15:00:00Z';

test('sem token da franquia: indisponível (nunca "livre"), e nem pergunta nada à franquia', async () => {
  const f = franquia();
  assert.equal(await confere({ ...UNIT, spineToken: null } as Unit, f), 'indisponivel');
  assert.deepEqual(f.chamadas, { agenda: 0, tratamentos: 0, ficha: 0, idClient: 0 });
});

test('ninguém na agenda, sem cadastro e sem tratamento: livre', async () => {
  assert.equal(await confere(UNIT, franquia()), 'livre');
});

test('consulta futura na FICHA do paciente barra, em qualquer um dos três status de "marcado"', async () => {
  for (const idStatus of [SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.REMARCADO]) {
    const f = franquia({ idClient: 7, ficha: { schedules: [{ clientName: null, dateAttendanceUtc: amanha, idStatus }], treatments: [] } });
    assert.equal(await confere(UNIT, f), 'consulta-futura', `status ${idStatus}`);
  }
});

test('na ficha, consulta PASSADA, desmarcada ou que faltou NÃO barra (a pessoa pode receber)', async () => {
  for (const [data, idStatus] of [[ontem, SPINE_STATUS.AGENDADO], [amanha, SPINE_STATUS.DESMARCADO], [amanha, SPINE_STATUS.NAO_COMPARECEU]] as const) {
    const f = franquia({ idClient: 7, ficha: { schedules: [{ clientName: null, dateAttendanceUtc: data, idStatus }], treatments: [] } });
    assert.equal(await confere(UNIT, f), 'livre', `${data} ${idStatus}`);
  }
});

test('tratamento aberto na ficha barra; finalizado e cancelado não', async () => {
  const com = (statusName: string) => franquia({ idClient: 7, ficha: { schedules: [], treatments: [{ idStatus: null, statusName }] } });
  assert.equal(await confere(UNIT, com('EM ANDAMENTO')), 'tratamento-aberto');
  assert.equal(await confere(UNIT, com('PENDENTE')), 'tratamento-aberto');
  assert.equal(await confere(UNIT, com('FINALIZADO')), 'livre');
  assert.equal(await confere(UNIT, com('CANCELADO')), 'livre');
});

test('ficha que a franquia não devolveu (getClient falhou): indisponível, nunca "livre"', async () => {
  assert.equal(await confere(UNIT, franquia({ idClient: 7, ficha: 'falha' })), 'indisponivel');
});

test('exceção no meio da conferência: indisponível, nunca "livre"', async () => {
  assert.equal(await confere(UNIT, franquia({ idClient: 7, ficha: 'lanca' })), 'indisponivel');
});

test('agenda da unidade que falhou ou lançou erro: indisponível, nunca "livre"', async () => {
  assert.equal(await confere(UNIT, franquia({ agenda: 'falha' })), 'indisponivel');
  assert.equal(await confere(UNIT, franquia({ agenda: 'lanca' })), 'indisponivel');
  assert.equal(await confere(UNIT, franquia({ tratamentos: 'falha' })), 'indisponivel');
});

test('segunda rede: sem cadastro casado, o NOME na agenda futura barra (e passado, não); acento e caixa não atrapalham', async () => {
  const agenda = (dateAttendanceUtc: string, idStatus: number = SPINE_STATUS.AGENDADO): Sch[] => [{ clientName: 'MARIA DA SILVA', dateAttendanceUtc, idStatus }];
  assert.equal(await confere(UNIT, franquia({ agenda: agenda(amanha) })), 'consulta-futura');
  assert.equal(await confere(UNIT, franquia({ agenda: agenda(ontem) })), 'livre');
  assert.equal(await confere(UNIT, franquia({ agenda: agenda(amanha, SPINE_STATUS.DESMARCADO) })), 'livre');
  assert.equal(await confere(UNIT, franquia({ agenda: [{ clientName: 'Mária da Silva', dateAttendanceUtc: amanha, idStatus: SPINE_STATUS.CONFIRMADO }] })), 'consulta-futura');
  assert.equal(await confere(UNIT, franquia({ agenda: [{ clientName: 'Outra Pessoa', dateAttendanceUtc: amanha, idStatus: SPINE_STATUS.AGENDADO }] })), 'livre');
  assert.equal(await confere(UNIT, franquia({ tratamentos: [{ clientName: 'Maria da Silva', statusName: 'EM ANDAMENTO' }] })), 'tratamento-aberto');
  assert.equal(await confere(UNIT, franquia({ tratamentos: [{ clientName: 'Maria da Silva', statusName: 'FINALIZADO' }] })), 'livre');
});

test('LEITURA CORTADA no teto de páginas = indisponível: quem está depois do corte NÃO passa como livre (o caso do Outubro Rosa)', async () => {
  // a pessoa tem consulta, mas a franquia devolveu só as primeiras 2.000: sem o corte marcado, ela viria como "livre"
  assert.equal(await confere(UNIT, franquia({ agenda: [], agendaTruncada: true })), 'indisponivel');
  assert.equal(await confere(UNIT, franquia({ tratamentos: [], tratamentosTruncada: true })), 'indisponivel');
  assert.equal(await confere(UNIT, franquia({ agenda: [], agendaTruncada: false, tratamentosTruncada: false })), 'livre');
});

test('a leitura em bloco acontece UMA vez por conferência (cada pessoa custa só o paciente); falha vale 1 minuto', async () => {
  const f = franquia();
  const c = conferenciaDaFranquia(UNIT, () => AGORA, f.porta);
  await c(PESSOA);
  await c({ ...PESSOA, nomeCompleto: 'Joana Souza', leadId: 11 });
  assert.equal(f.chamadas.agenda, 1);
  assert.equal(f.chamadas.tratamentos, 1);
  const quebrada = franquia({ agenda: 'falha' });
  const c2 = conferenciaDaFranquia(UNIT, () => AGORA, quebrada.porta);
  await c2(PESSOA);
  await c2(PESSOA);
  assert.equal(quebrada.chamadas.agenda, 1, 'não martela a franquia que está fora do ar');
});

test('sem leadId não procura cadastro: só a agenda por nome decide', async () => {
  const f = franquia({ idClient: 7 });
  assert.equal(await confere(UNIT, f, { ...PESSOA, leadId: null }), 'livre');
  assert.equal(f.chamadas.idClient, 0);
});
