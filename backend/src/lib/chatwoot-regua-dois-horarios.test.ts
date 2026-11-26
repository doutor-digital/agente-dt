/**
 * Duas sessões (ou consultas) da mesma pessoa no MESMO dia viram UMA mensagem com os dois horários («18/11 às 09:00 e 14:30»), e o lembrete do 2º horário
 * não sai de novo. O caso de Timbó na Kommo (9h00 + 9h30, que lembrava só a das 9h30), agora no CRM.
 * A agenda grava `outros_horarios_do_dia` (única que escreve); a régua só lê. Datas: 2026-11-18 é quarta; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as regua from './chatwoot-regua.js';
import { decidirRegua, type ConversaRegua, type DadosDaUnidade, type Visto } from './chatwoot-regua.js';
import * as agendaMod from './chatwoot-agenda.js';
import type { SpineSchedule } from '../services/spine.service.js';

const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const Z = (s: string) => new Date(s);
const vistos = new Map<string, Visto>([['_visto', { valor: '1', desde: Z('2026-11-10T12:00:00Z'), inicial: false }]]);

function conv(attrs: Record<string, unknown>): ConversaRegua {
  return { id: 10, nome: 'maria da silva', etiquetas: [], attrs, criadaEm: Z('2026-10-01T12:00:00Z'), atendente: 'Ana', ultima: null };
}
const SESSAO = { categoria_consulta: 'Sessão', situacao_consulta: 'Agendado', data_consulta: '2026-11-18', hora_consulta: '09:00' };
const AVALIACAO = { etapa: 'Agendado', categoria_consulta: 'Avaliação', situacao_consulta: 'Agendado', data_consulta: '2026-11-18', hora_consulta: '09:00' };

type Saiu = { quando: string; regra: string; chave: string; texto: string | null; cobre?: string[] };

/**
 * Faz o que o WORKER faz: a cada passo de 10 min decide, registra o que saiu como feito E as chaves que a mensagem cobre. `trocaEm`: quando a agenda
 * passa a apontar para a sessão seguinte (a 1ª foi atendida): os atributos viram `depois`.
 */
function dia(antes: Record<string, unknown>, depois?: { em: string; attrs: Record<string, unknown> }): Saiu[] {
  const feitos = new Set<string>();
  const saiu: Saiu[] = [];
  for (let t = Z('2026-11-17T11:00:00Z').getTime(); t <= Z('2026-11-18T23:00:00Z').getTime(); t += 10 * 60_000) {
    const attrs = depois && t >= Z(depois.em).getTime() ? depois.attrs : antes;
    for (const d of decidirRegua(conv(attrs), { vistos, feitos }, new Date(t), U).disparos) {
      feitos.add(`${d.regra}|${d.chave}`);
      for (const ch of d.cobre ?? []) feitos.add(`${d.regra}|${ch}`);
      saiu.push({ quando: new Date(t).toISOString(), regra: d.regra, chave: d.chave, texto: d.texto, ...(d.cobre ? { cobre: d.cobre } : {}) });
    }
  }
  return saiu;
}

test('outrosHorarios: só horários DEPOIS do principal, válidos, sem repetir, em ordem; sem hora principal não vale', () => {
  const principal = { data: { y: 2026, m: 11, d: 18, iso: '2026-11-18' }, hora: { hh: 9, mm: 0 }, chave: '2026-11-18T09:00' };
  const f = (v: unknown) => (regua as unknown as { outrosHorarios: (v: unknown, m: typeof principal | null) => string[] }).outrosHorarios(v, principal);
  assert.deepEqual(f('14:30'), ['14:30']);
  assert.deepEqual(f('17:00, 14:30; 14h30'), ['14:30', '17:00']);
  assert.deepEqual(f('08:00, 09:00'), [], 'antes ou igual ao principal não é «mais tarde»');
  assert.deepEqual(f('lixo, 25:99'), []);
  assert.deepEqual(f(undefined), []);
  assert.deepEqual((regua as unknown as { outrosHorarios: (v: unknown, m: null) => string[] }).outrosHorarios('14:30', null), []);
  assert.deepEqual((regua as unknown as { outrosHorarios: (v: unknown, m: unknown) => string[] }).outrosHorarios('14:30', { ...principal, hora: null }), []);
});

test('duas sessões no mesmo dia: UMA mensagem de véspera e UMA de «hoje», cada uma com os dois horários (texto de sessão)', () => {
  const r = dia({ ...SESSAO, outros_horarios_do_dia: '14:30' });
  assert.deepEqual(r.map((x) => x.regra), ['consulta-vespera', 'sessao-dia']);
  assert.match(r[0]!.texto!, /A sua sessão é amanhã\.\nData e horário: 18\/11 às 09:00 e 14:30\n/);
  assert.match(r[1]!.texto!, /A sua sessão de hoje está marcada para 18\/11 às 09:00 e 14:30\./);
  assert.deepEqual(r[0]!.cobre, ['2026-11-18T14:30']);
});

test('três horários no dia: «09:00, 14:30 e 17:00»', () => {
  const r = dia({ ...SESSAO, outros_horarios_do_dia: '14:30, 17:00' });
  assert.match(r[0]!.texto!, /18\/11 às 09:00, 14:30 e 17:00/);
});

test('depois que a agenda passa para a 2ª sessão (a 1ª foi atendida), o lembrete dela NÃO sai de novo: a mensagem do 1º horário já a citou', () => {
  const r = dia({ ...SESSAO, outros_horarios_do_dia: '14:30' }, { em: '2026-11-18T13:00:00Z', attrs: { ...SESSAO, hora_consulta: '14:30', outros_horarios_do_dia: '' } });
  assert.deepEqual(r.map((x) => `${x.regra}@${x.chave}`), ['consulta-vespera@2026-11-18T09:00', 'sessao-dia@2026-11-18T09:00']);
});

test('SEM o outro horário no cartão (a agenda ainda não gravou) nada muda: texto de um horário só, e o lembrete da 2ª sessão sai como antes', () => {
  const r = dia({ ...SESSAO }, { em: '2026-11-18T13:00:00Z', attrs: { ...SESSAO, hora_consulta: '14:30' } });
  assert.match(r[0]!.texto!, /18\/11 às 09:00\n/);
  assert.doesNotMatch(r[0]!.texto!, / e 14:30/);
  assert.equal(r.some((x) => x.chave === '2026-11-18T14:30'), true, 'a 2ª sessão ainda recebe o dela (a régua não sabia dela)');
});

test('consulta de avaliação + o outro horário do dia: véspera, «hoje» e o preparo (que não cita horário) saem uma vez cada', () => {
  const r = dia({ ...AVALIACAO, outros_horarios_do_dia: '14:30' }, { em: '2026-11-18T13:00:00Z', attrs: { ...AVALIACAO, hora_consulta: '14:30' } });
  assert.deepEqual(r.map((x) => x.regra), ['consulta-vespera', 'consulta-dia', 'consulta-preparo']);
  assert.match(r[0]!.texto!, /18\/11 às 09:00 e 14:30/);
  assert.match(r[1]!.texto!, /18\/11 às 09:00 e 14:30/);
});

// ── a agenda é a única que escreve o campo ────────────────────────────────────────────────────────

/** lidas do módulo (não importadas por nome): o arquivo roda igual no código antigo e mostra o que NÃO acontecia */
const mudancas = agendaMod.mudancas as (a: Record<string, unknown>, d: Record<string, unknown>) => Record<string, string>;
const outrosHorariosDoDia = (agendaMod as unknown as { outrosHorariosDoDia: (v: SpineSchedule, l: SpineSchedule[], h: string) => string }).outrosHorariosDoDia;
const ag = (o: Partial<SpineSchedule>): SpineSchedule => ({
  idSchedule: 1, idTreatment: null, idStatus: 1, statusName: 'Agendado', clientName: 'Maria da Silva', categoryName: 'Sessão', physicalTherapist: null,
  dateAttendanceUtc: null, dateAttendanceLocal: null, dayLocal: '2026-11-18', timeLocal: '09:00:00', isBusy: false, requiresManualValidation: false, ...o,
});

test('agenda: os outros horários de pé do mesmo dia, depois do que vale', () => {
  const a = ag({});
  const b = ag({ idSchedule: 2, timeLocal: '14:30:00' });
  const c = ag({ idSchedule: 3, timeLocal: '17:00:00' });
  const cedo = ag({ idSchedule: 4, timeLocal: '07:00:00' });
  const outroDia = ag({ idSchedule: 5, dayLocal: '2026-11-19', timeLocal: '15:00:00' });
  const cancelada = ag({ idSchedule: 6, timeLocal: '16:00:00', statusName: 'Desmarcado' });
  const igual = ag({ idSchedule: 7, timeLocal: '09:00:00' });
  assert.equal(outrosHorariosDoDia(a, [a, b, c, cedo, outroDia, cancelada, igual], '2026-11-17'), '14:30, 17:00');
  assert.equal(outrosHorariosDoDia(a, [a], '2026-11-17'), '');
  assert.equal(outrosHorariosDoDia(a, [a, b], '2026-11-19'), '', 'o que vale já passou: nada a anunciar');
  assert.equal(outrosHorariosDoDia(ag({ statusName: 'Desmarcado' }), [b], '2026-11-17'), '', 'o que vale não está de pé');
  assert.equal(outrosHorariosDoDia(ag({ timeLocal: null }), [b], '2026-11-17'), '');
});

test('agenda: grava o campo quando muda, limpa quando deixa de valer, e não mexe quando está igual (sem regravação eterna)', () => {
  const d = { data_consulta: '2026-11-18', hora_consulta: '09:00', situacao_consulta: 'Agendado', categoria_consulta: 'Sessão', outros_horarios_do_dia: '14:30' };
  const atual = { data_consulta: '2026-11-18', hora_consulta: '09:00', situacao_consulta: 'Agendado', categoria_consulta: 'Sessão' };
  assert.deepEqual(mudancas(atual, d), { outros_horarios_do_dia: '14:30' });
  assert.deepEqual(mudancas({ ...atual, outros_horarios_do_dia: '14:30' }, d), {}, 'igual: nada a gravar');
  assert.deepEqual(mudancas({ ...atual, outros_horarios_do_dia: '14:30' }, { ...d, outros_horarios_do_dia: '' }), { outros_horarios_do_dia: '' }, 'passou a 2ª sessão: limpa');
  assert.deepEqual(mudancas(atual, { ...d, outros_horarios_do_dia: '' }), {}, 'nunca houve e não há: nada a gravar');
  assert.deepEqual(mudancas(atual, { ...d, outros_horarios_do_dia: undefined }), {}, 'sem a informação: nada a gravar');
});

// ── correções da revisão ──────────────────────────────────────────────────────────────────────────

test('agenda: só entram no lembrete os horários do MESMO tipo (uma sessão da tarde não vira «e 14:30» na avaliação da manhã)', () => {
  const avaliacao = ag({ categoryName: 'Avaliação' });
  const sessaoTarde = ag({ idSchedule: 2, categoryName: 'Sessão', timeLocal: '14:30:00' });
  const avaliacaoTarde = ag({ idSchedule: 3, categoryName: 'Avaliação', timeLocal: '16:00:00' });
  assert.equal(outrosHorariosDoDia(avaliacao, [avaliacao, sessaoTarde], '2026-11-17'), '');
  assert.equal(outrosHorariosDoDia(avaliacao, [avaliacao, sessaoTarde, avaliacaoTarde], '2026-11-17'), '16:00');
});

test('agenda: a nota da agenda não mostra valor em branco quando o campo é limpo', () => {
  const { descricao } = agendaMod as unknown as { descricao: (m: Record<string, string>) => string };
  assert.equal(descricao({ outros_horarios_do_dia: '' }), 'outros horários do dia = (nenhum)');
  assert.equal(descricao({ outros_horarios_do_dia: '14:30' }), 'outros horários do dia = 14:30');
});

test('«Robôs»: o registro «coberto» não conta como mensagem enviada nem como nota, e não aparece na aba «Enviados»', async () => {
  const E = await import('./robos-estado.js');
  const agora = Z('2026-11-18T15:00:00Z');
  const base = { caixa: 3, conversationId: 7, criadoEm: Z('2026-11-17T12:00:00Z') };
  const banco = {
    async linhas() { return []; },
    async salvar() {},
    async disparos() {
      return [
        { ...base, regra: 'consulta-vespera', chave: '2026-11-18T09:00', modo: 'ligado', texto: 'Olá, Maria.' },
        { ...base, regra: 'consulta-vespera', chave: '2026-11-18T14:30', modo: 'coberto', texto: 'coberto pela mensagem de 2026-11-18T09:00' },
      ];
    },
  };
  const visao = await E.visaoDosRobos(banco as never, 'doutor-hernia-parauapebas', { agora, aprovados: null });
  const vespera = visao.robos.find((r) => r.regra === 'consulta-vespera')!;
  assert.equal(vespera.enviados7d, 1, 'só a mensagem de verdade');
  assert.equal(vespera.notas7d, 0);
  const env = await E.enviadosDaUnidade(banco as never, 'doutor-hernia-parauapebas', async () => null, agora);
  assert.equal(env.total, 1);
  assert.equal(env.itens.length, 1);
});
