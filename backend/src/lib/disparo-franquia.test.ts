import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { conferenciaDaFranquia, janelasDaAgenda, type FranquiaPorta } from './disparo/franquia.js';
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
  /** a agenda por janela (na ordem das chamadas): sobrepõe `agenda`, para provar a junção e a janela que falha */
  agendaPorJanela?: Array<Sch[] | 'falha' | 'truncada'>;
  tratamentosTruncada?: boolean;
  idClient?: number | null;
  ficha?: { schedules: Sch[]; treatments: Array<{ idStatus: number | null; statusName: string | null }> } | 'falha' | 'lanca';
} = {}) {
  const chamadas = { agenda: 0, tratamentos: 0, ficha: 0, idClient: 0 };
  const janelas: Array<[string, string]> = [];
  const porta: FranquiaPorta = {
    searchSchedules: (async (_u: unknown, p: { initialDate: string; endDate: string }) => {
      chamadas.agenda++;
      janelas.push([p.initialDate, p.endDate]);
      // A franquia de verdade: intervalo maior que 100 dias (com o fim EXCLUSIVO que `searchSchedules` manda) é HTTP 400.
      const dias = (Date.parse(`${p.endDate}T00:00:00Z`) - Date.parse(`${p.initialDate}T00:00:00Z`)) / 86_400_000 + 1;
      if (dias > 100) return { ok: false, error: '400: Intervalo de datas não pode ser maior que 100 dias.' };
      if (o.agendaPorJanela) {
        const daJanela = o.agendaPorJanela[chamadas.agenda - 1];
        if (daJanela === 'falha' || daJanela === undefined) return { ok: false, error: 'fora do ar' };
        if (daJanela === 'truncada') return { ok: true, data: { schedules: [], pages: 40, total: 0, truncada: true } };
        return { ok: true, data: { schedules: daJanela, pages: 1, total: 0 } };
      }
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
  return { porta, chamadas, janelas };
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
  assert.equal(f.chamadas.agenda, janelasDaAgenda('2026-10-26').length, 'uma leitura = uma chamada por janela, e só uma leitura');
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

// ── a janela de 100 dias da franquia (27/10: 45 de 50 pessoas barradas por "a franquia não respondeu") ───────────

test('as janelas da agenda cobrem hoje..+180 sem buraco nem sobreposição, e nenhuma passa de 100 dias', () => {
  const j = janelasDaAgenda('2026-10-26');
  assert.deepEqual(j, [['2026-10-26', '2027-01-24'], ['2027-01-25', '2027-04-24']]);
  const dia = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  for (const [a, b] of j) assert.ok(dia(b) - dia(a) + 2 <= 100, `${a}..${b} com o fim exclusivo cabe em 100 dias`);
  assert.equal(dia(j[1]![0]) - dia(j[0]![1]), 1, 'a segunda começa no dia seguinte ao fim da primeira');
  assert.equal(dia(j.at(-1)![1]) - dia('2026-10-26'), 180, 'termina em hoje + 180');
});

test('a leitura NÃO pede a agenda num intervalo só de 180 dias: a franquia de verdade responde 400 (o bug do #126)', async () => {
  const f = franquia();
  assert.equal(await confere(UNIT, f), 'livre', 'com janelas, a franquia responde e a pessoa sem nada é livre');
  assert.equal(f.janelas.length, 2);
  // o mesmo mock, chamado como o código antigo chamava, recusa — se o mock não recusasse, este teste não pegaria o bug
  const antigo = await f.porta.searchSchedules({} as never, { initialDate: '2026-10-26', endDate: '2027-04-24' });
  assert.equal(antigo.ok, false);
  assert.match(String((antigo as { error?: string }).error), /100 dias/);
});

test('as duas janelas somam: consulta marcada em QUALQUER uma delas barra', async () => {
  const daPrimeira: Sch[] = [{ clientName: 'Maria da Silva', dateAttendanceUtc: '2026-11-20T15:00:00Z', idStatus: SPINE_STATUS.AGENDADO }];
  const daSegunda: Sch[] = [{ clientName: 'Maria da Silva', dateAttendanceUtc: '2027-03-10T15:00:00Z', idStatus: SPINE_STATUS.AGENDADO }];
  assert.equal(await confere(UNIT, franquia({ agendaPorJanela: [daPrimeira, []] })), 'consulta-futura');
  assert.equal(await confere(UNIT, franquia({ agendaPorJanela: [[], daSegunda] })), 'consulta-futura', 'a consulta da 2ª janela é a que o intervalo único perdia');
  assert.equal(await confere(UNIT, franquia({ agendaPorJanela: [[], []] })), 'livre');
});

test('a mesma consulta nas duas janelas não duplica (e continua barrando)', async () => {
  const mesma = { clientName: 'Joana Souza', dateAttendanceUtc: '2027-01-24T22:00:00Z', idStatus: SPINE_STATUS.AGENDADO, idSchedule: 5 } as Sch;
  assert.equal(await confere(UNIT, franquia({ agendaPorJanela: [[mesma], [mesma]] }), { ...PESSOA, nomeCompleto: 'Joana Souza' }), 'consulta-futura');
});

test('uma janela que falha ou vem cortada no teto de páginas torna a leitura INDISPONÍVEL, mesmo que a outra venha vazia', async () => {
  assert.equal(await confere(UNIT, franquia({ agendaPorJanela: [[], 'falha'] })), 'indisponivel', '2ª janela falhou');
  assert.equal(await confere(UNIT, franquia({ agendaPorJanela: ['falha', []] })), 'indisponivel', '1ª janela falhou');
  assert.equal(await confere(UNIT, franquia({ agendaPorJanela: [[], 'truncada'] })), 'indisponivel', '2ª janela truncada');
  assert.equal(await confere(UNIT, franquia({ agendaPorJanela: ['truncada', []] })), 'indisponivel', '1ª janela truncada');
});

test('janela que falha: a leitura para ali (não martela a franquia) e a falha vale 1 minuto como antes', async () => {
  const f = franquia({ agendaPorJanela: ['falha'] });
  const c = conferenciaDaFranquia(UNIT, () => AGORA, f.porta);
  await c(PESSOA);
  await c(PESSOA);
  assert.equal(f.chamadas.agenda, 1);
  assert.equal(f.chamadas.tratamentos, 0, 'nem chegou aos tratamentos');
});
