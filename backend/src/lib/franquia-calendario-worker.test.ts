import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { _limparMemoriaDoCalendario, varrerCalendario, type DepsDoCalendario } from './franquia-calendario-worker.js';
import type { KommoClient, KommoTarefa } from '../services/kommo.service.js';
import type { SpineSchedule } from '../services/spine.service.js';

const unit = { id: 'u-timbo', slug: 'doutor-hernia-timbo', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
const AGORA = new Date('2026-11-02T15:00:00.000Z'); // 12:00 local

const ag = (o: Partial<SpineSchedule> = {}): SpineSchedule => ({
  idSchedule: 3784113, idTreatment: null, idStatus: 37, statusName: 'AGENDADO', clientName: 'INGRIDE SOUZA LIMA', categoryName: 'AVALIAÇÃO',
  physicalTherapist: 'DR. LEONARDO PEREIRA', dateAttendanceUtc: '2026-11-03T17:00:00.000Z', dateAttendanceLocal: null, dayLocal: null, timeLocal: '14:00',
  isBusy: true, requiresManualValidation: false, ...o,
});

interface Chamadas {
  criadas: Array<Record<string, unknown>>;
  atualizadas: Array<{ id: number; args: Record<string, unknown> }>;
  fechadas: Array<{ id: number; resultado: string }>;
  tipos: number;
}

function kommoFalso(abertas: KommoTarefa[], opcoes: { completa?: boolean; falhaNaLista?: boolean; tipos?: Array<{ id: number; name: string }> } = {}) {
  const c: Chamadas = { criadas: [], atualizadas: [], fechadas: [], tipos: 0 };
  let proximo = 7000;
  const kommo = {
    subdomain: `timbosc-${Math.random()}`,
    listarTiposDeTarefa: async () => { c.tipos++; return opcoes.tipos ?? [{ id: 1, name: 'Follow-up' }, { id: 4302851, name: 'Consulta' }]; },
    listarTarefasAbertas: async () => {
      if (opcoes.falhaNaLista) throw new Error('503');
      return { tarefas: abertas, completa: opcoes.completa ?? true };
    },
    createTask: async (a: Record<string, unknown>) => { c.criadas.push(a); return { id: proximo++ }; },
    atualizarTarefa: async (id: number, args: Record<string, unknown>) => { c.atualizadas.push({ id, args }); },
    fecharTarefa: async (id: number, resultado: string) => { c.fechadas.push({ id, resultado }); },
  } as unknown as KommoClient;
  return { kommo, c };
}

const deps = (kommo: KommoClient, agenda: SpineSchedule[], extra: Partial<DepsDoCalendario> = {}): DepsDoCalendario => ({
  kommo,
  agora: AGORA,
  pausaMs: 0,
  buscarAgenda: async () => ({ ok: true, agendamentos: agenda }),
  resolver: async () => ({ leadId: 555, confirmado: true }),
  telefone: async () => '+5547999990000',
  ...extra,
});

beforeEach(() => {
  _limparMemoriaDoCalendario();
  process.env.FRANQUIA_CALENDARIO_RESPONSAVEL = 'doutor-hernia-timbo:15905863';
  delete process.env.FRANQUIA_CALENDARIO_TIPO;
  delete process.env.FRANQUIA_CALENDARIO_DURACAO_MIN;
});

test('modo seco (o padrão): conta o que criaria e NÃO escreve nada no Kommo', async () => {
  const { kommo, c } = kommoFalso([
    { id: 1, text: '⚕ AVALIAÇÃO 10:00 · AGENDADO [ag:11]', complete_till: Date.parse('2026-11-05T13:00:00Z') / 1000, entity_id: 9 },
  ]);
  const r = await varrerCalendario(unit, deps(kommo, [ag(), ag({ idSchedule: 22, statusName: 'ATENDIDO' })], { modo: 'seco' }));
  assert.equal(r.modo, 'seco');
  assert.equal(r.criadas, 1);
  assert.equal(r.sumiram, 1);
  assert.deepEqual([c.criadas, c.atualizadas, c.fechadas], [[], [], []]);
});

test('desligado: nem lê a franquia', async () => {
  const { kommo } = kommoFalso([]);
  let leu = false;
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'desligado', buscarAgenda: async () => { leu = true; return { ok: true, agendamentos: [] }; } }));
  assert.equal(leu, false);
  assert.equal(r.criadas, 0);
});

test('aplicar: cria a tarefa no cartão, com responsável, tipo "Consulta" achado pelo nome, duração e horário da consulta', async () => {
  const { kommo, c } = kommoFalso([]);
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(r.criadas, 1);
  assert.equal(r.semCartao, 0);
  assert.deepEqual(c.criadas, [{
    leadId: 555,
    text: '🩺 AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113]',
    completeAt: Date.parse('2026-11-03T17:00:00Z') / 1000,
    responsibleUserId: 15905863,
    taskTypeId: 4302851,
    manterResponsavel: true,
    durationSec: 3600,
  }]);
});

test('aplicar: tipo configurado por unidade vence a busca por nome; duração 0 não manda duração', async () => {
  process.env.FRANQUIA_CALENDARIO_TIPO = 'doutor-hernia-timbo:77';
  process.env.FRANQUIA_CALENDARIO_DURACAO_MIN = '0';
  const { kommo, c } = kommoFalso([]);
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(c.criadas[0].taskTypeId, 77);
  assert.equal(c.criadas[0].durationSec, undefined);
  assert.equal(c.tipos, 0);
});

test('aplicar: conta sem tipo "Consulta" usa o tipo 1', async () => {
  const { kommo, c } = kommoFalso([], { tipos: [{ id: 1, name: 'Follow-up' }, { id: 2, name: 'Reunião' }] });
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(c.criadas[0].taskTypeId, 1);
});

test('idempotente: a 2ª varredura, com a tarefa já no Kommo, não cria nada (reinício do worker)', async () => {
  const { kommo, c } = kommoFalso([]);
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(c.criadas.length, 1);
  _limparMemoriaDoCalendario(); // o worker reiniciou: a memória se foi, o marcador no Kommo fica
  const { kommo: k2, c: c2 } = kommoFalso([{
    id: 7000, text: '⚕ AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113]', complete_till: Date.parse('2026-11-03T17:00:00Z') / 1000, entity_id: 555,
  }]);
  const r = await varrerCalendario(unit, deps(k2, [ag()], { modo: 'aplicar' }));
  assert.deepEqual([r.criadas, r.atualizadas, r.fechadas, r.erros], [0, 0, 0, 0]);
  assert.deepEqual([c2.criadas, c2.atualizadas, c2.fechadas], [[], [], []]);
});

test('memória: a lista do Kommo atrasada não faz criar de novo o que acabou de ser criado', async () => {
  const { kommo, c } = kommoFalso([]);
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' })); // a lista ainda vem vazia
  assert.equal(c.criadas.length, 1);
});

test('sem cartão: tarefa SOLTA (leadId nulo) com nome e telefone no texto, e conta em semCartao', async () => {
  const { kommo, c } = kommoFalso([]);
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar', resolver: async () => ({ leadId: null, confirmado: true }) }));
  assert.equal(r.semCartao, 1);
  assert.equal(r.cartaoIncerto, 0);
  assert.equal(c.criadas[0].leadId, null);
  assert.match(String(c.criadas[0].text), /\[ag:3784113\] Paciente: INGRIDE SOUZA LIMA · Tel: \+5547999990000$/);
});

test('cartão incerto (telefone casou com vários cartões): NÃO crava a tarefa no cartão da mãe/filha — vai solta', async () => {
  const { kommo, c } = kommoFalso([]);
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar', resolver: async () => ({ leadId: 555, confirmado: false }) }));
  assert.equal(c.criadas[0].leadId, null);
  assert.equal(r.semCartao, 1);
  assert.equal(r.cartaoIncerto, 1);
});

test('atualiza o horário e fecha por status, na mesma varredura', async () => {
  const antes = Date.parse('2026-11-03T17:00:00Z') / 1000;
  const { kommo, c } = kommoFalso([
    { id: 1, text: '⚕ AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:11]', complete_till: antes, entity_id: 9 },
    { id: 2, text: '⚕ SESSÃO 09:00 · Dr. Leonardo · AGENDADO [ag:22]', complete_till: antes, entity_id: 9 },
  ]);
  const r = await varrerCalendario(unit, deps(kommo, [
    ag({ idSchedule: 11, dateAttendanceUtc: '2026-11-03T18:00:00.000Z' }), // 14:00 → 15:00
    ag({ idSchedule: 22, statusName: 'FALTOU', categoryName: 'SESSÃO' }),
  ], { modo: 'aplicar' }));
  assert.deepEqual([r.atualizadas, r.fechadas, r.criadas], [1, 1, 0]);
  assert.equal(c.atualizadas[0].id, 1);
  assert.equal(c.atualizadas[0].args.completeAt, Date.parse('2026-11-03T18:00:00Z') / 1000);
  assert.deepEqual(c.fechadas, [{ id: 2, resultado: 'Faltou' }]);
});

test('o Kommo não guardou a atualização: não regrava a cada varredura (dois escritores = regravação eterna)', async () => {
  const antes = Date.parse('2026-11-03T17:00:00Z') / 1000;
  const lista: KommoTarefa[] = [{ id: 1, text: '⚕ AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:11]', complete_till: antes, entity_id: 9 }];
  const { kommo, c } = kommoFalso(lista);
  const d = deps(kommo, [ag({ idSchedule: 11, statusName: 'CONFIRMADO' })], { modo: 'aplicar' });
  await varrerCalendario(unit, d);
  await varrerCalendario(unit, d); // a lista continua igual: o Kommo "não guardou"
  await varrerCalendario(unit, d);
  assert.equal(c.atualizadas.length, 1);
});

test('lista de tarefas ilegível: nada é feito (criaria duplicada) e o erro é contado', async () => {
  const { kommo, c } = kommoFalso([], { falhaNaLista: true });
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(r.erros, 1);
  assert.deepEqual(c.criadas, []);
});

test('lista de tarefas cortada no teto: não cria tarefa nova (pode já existir além do corte), mas ainda fecha as conhecidas', async () => {
  const { kommo, c } = kommoFalso([
    { id: 2, text: '⚕ SESSÃO 09:00 · AGENDADO [ag:22]', complete_till: Date.parse('2026-11-03T12:00:00Z') / 1000, entity_id: 9 },
  ], { completa: false });
  const r = await varrerCalendario(unit, deps(kommo, [ag(), ag({ idSchedule: 22, statusName: 'ATENDIDO' })], { modo: 'aplicar' }));
  assert.deepEqual(c.criadas, []);
  assert.deepEqual(c.fechadas, [{ id: 2, resultado: 'Atendido' }]);
  assert.equal(r.criadas, 0);
});

test('agenda da franquia fora do ar: não fecha nem cria nada', async () => {
  const { kommo, c } = kommoFalso([{ id: 2, text: 'SESSÃO [ag:22]', complete_till: Date.parse('2026-11-03T12:00:00Z') / 1000, entity_id: 9 }]);
  const r = await varrerCalendario(unit, deps(kommo, [], { modo: 'aplicar', buscarAgenda: async () => ({ ok: false, erro: 'timeout', agendamentos: [] }) }));
  assert.equal(r.erros, 1);
  assert.deepEqual([c.criadas, c.atualizadas, c.fechadas], [[], [], []]);
});

test('erro numa tarefa não derruba as outras', async () => {
  const { kommo, c } = kommoFalso([]);
  let n = 0;
  (kommo as unknown as { createTask: unknown }).createTask = async (a: Record<string, unknown>) => {
    if (n++ === 0) throw new Error('422');
    c.criadas.push(a);
    return { id: 1 };
  };
  const r = await varrerCalendario(unit, deps(kommo, [ag({ idSchedule: 1 }), ag({ idSchedule: 2 })], { modo: 'aplicar' }));
  assert.equal(r.erros, 1);
  assert.equal(c.criadas.length, 1);
});

test('busca da franquia truncada: não aponta tarefa como "sumida" (a lista está incompleta)', async () => {
  const { kommo } = kommoFalso([{ id: 2, text: '⚕ SESSÃO [ag:22]', complete_till: Date.parse('2026-11-03T12:00:00Z') / 1000, entity_id: 9 }]);
  const r = await varrerCalendario(unit, deps(kommo, [], { modo: 'aplicar', buscarAgenda: async () => ({ ok: true, agendamentos: [], truncada: true }) }));
  assert.equal(r.sumiram, 0);
});
