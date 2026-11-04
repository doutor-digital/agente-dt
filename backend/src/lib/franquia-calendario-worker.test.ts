import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { _limparMemoriaDoCalendario, CRIADA_RECENTE_MS, faixasPorConta, paraleloDoCalendario, rodadaSecaLimpa, rodarEmFaixas, varrerCalendario, type DepsDoCalendario } from './franquia-calendario-worker.js';
import type { GrupoDoCrm } from './crm-compartilhado.js';
import { KommoApiError, type KommoClient, type KommoTarefa } from '../services/kommo.service.js';
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

function kommoFalso(
  abertas: KommoTarefa[],
  opcoes: { completa?: boolean; falhaNaLista?: boolean; tipos?: Array<{ id: number; name: string }>; concluidas?: KommoTarefa[]; falhaNasConcluidas?: boolean; falhaNosTipos?: boolean } = {},
) {
  const c: Chamadas = { criadas: [], atualizadas: [], fechadas: [], tipos: 0 };
  let proximo = 7000;
  const kommo = {
    subdomain: `timbosc-${Math.random()}`,
    listarTiposDeTarefa: async () => {
      c.tipos++;
      if (opcoes.falhaNosTipos) throw new Error('429');
      return opcoes.tipos ?? [{ id: 1, name: 'Follow-up' }, { id: 4302851, name: 'Consulta' }];
    },
    listarTarefas: async (args: { concluidas?: boolean }) => {
      if (args.concluidas) {
        if (opcoes.falhaNasConcluidas) throw new Error('400');
        return { tarefas: opcoes.concluidas ?? [], completa: true };
      }
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
  lerConfig: async () => null,
  grupo: null,
  buscarAgenda: async () => ({ ok: true, agendamentos: agenda }),
  resolver: async () => ({ leadId: 555, confirmado: true, fone: '+5547999990000' }),
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
    text: '🩺 AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113] Paciente: INGRIDE SOUZA LIMA',
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

test('conta sem tipo "Consulta" e sem tipo configurado: a unidade FICA PARADA (nada de cair no tipo 1, que duplicaria quando o tipo fosse criado)', async () => {
  const { kommo, c } = kommoFalso([], { tipos: [{ id: 1, name: 'Follow-up' }, { id: 2, name: 'Reunião' }] });
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.deepEqual(c.criadas, []);
  assert.equal(r.erros, 1);
  assert.equal(r.criadas, 0);
});

test('o nome do paciente da franquia vai em TODA tarefa, também a que tem cartão (homônimos no mesmo cartão)', async () => {
  const { kommo, c } = kommoFalso([]);
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.match(String(c.criadas[0].text), /\[ag:3784113\] Paciente: INGRIDE SOUZA LIMA$/);
});

test('a tarefa solta usa o telefone que o resolver já achou: nenhuma segunda busca na franquia', async () => {
  const { kommo, c } = kommoFalso([]);
  let buscas = 0;
  await varrerCalendario(unit, deps(kommo, [ag(), ag({ idSchedule: 2 })], {
    modo: 'aplicar',
    resolver: async () => { buscas++; return { leadId: null, confirmado: true, fone: '+5547999990000' }; },
  }));
  assert.equal(buscas, 2);
  assert.match(String(c.criadas[1].text), /Tel: \+5547999990000$/);
});

test('lê a agenda desde hoje-14: a baixa que a recepção dá dias depois FECHA a tarefa (e nada é criado para o passado)', async () => {
  let lido: { de: string; ate: string } | null = null;
  const antes = Date.parse('2026-10-28T17:00:00Z') / 1000; // 5 dias atrás
  const { kommo, c } = kommoFalso([{ id: 3, text: '⚕ SESSÃO 14:00 · AGENDADO [ag:33]', complete_till: antes, entity_id: 9 }]);
  const r = await varrerCalendario(unit, deps(kommo, [
    ag({ idSchedule: 33, statusName: 'ATENDIDO', idStatus: 42, dateAttendanceUtc: '2026-10-28T17:00:00.000Z' }),
    ag({ idSchedule: 34, dateAttendanceUtc: '2026-10-28T17:00:00.000Z' }), // ainda AGENDADO, sem tarefa: passado, não cria
  ], { modo: 'aplicar', buscarAgenda: async (de, ate) => { lido = { de, ate }; return { ok: true, agendamentos: [
    ag({ idSchedule: 33, statusName: 'ATENDIDO', idStatus: 42, dateAttendanceUtc: '2026-10-28T17:00:00.000Z' }),
    ag({ idSchedule: 34, dateAttendanceUtc: '2026-10-28T17:00:00.000Z' }),
  ] }; } }));
  assert.deepEqual(lido, { de: '2026-10-19', ate: '2026-12-02' });
  assert.deepEqual(c.fechadas, [{ id: 3, resultado: 'Atendido' }]);
  assert.deepEqual(c.criadas, []);
  assert.equal(r.sumiram, 0);
});

test('o resumo diz quantas concluídas a leitura devolveu (para medir no seco se o filtro de prazo é ignorado)', async () => {
  const { kommo } = kommoFalso([], { concluidas: [
    { id: 5, text: '⚕ A [ag:1]', complete_till: Date.parse('2026-11-03T17:00:00Z') / 1000, result: { text: 'Falou com o paciente' } },
    { id: 6, text: 'outra tarefa qualquer', complete_till: Date.parse('2026-11-03T17:00:00Z') / 1000 },
  ] });
  const r = await varrerCalendario(unit, deps(kommo, [], { modo: 'seco' }));
  assert.equal(r.concluidasLidas, 2);
});

test('reativada na franquia (DESMARCADO → AGENDADO, mesmo registro): a tarefa que NÓS fechamos volta; a que a recepção concluiu, não', async () => {
  const quando = Date.parse('2026-11-03T17:00:00Z') / 1000;
  const nossa = kommoFalso([], { concluidas: [{ id: 5, text: '⚕ AVALIAÇÃO 14:00 · AGENDADO [ag:3784113]', complete_till: quando, result: { text: 'Desmarcado' } }] });
  await varrerCalendario(unit, deps(nossa.kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(nossa.c.criadas.length, 1);
  _limparMemoriaDoCalendario();
  const dela = kommoFalso([], { concluidas: [{ id: 5, text: '⚕ AVALIAÇÃO 14:00 · AGENDADO [ag:3784113]', complete_till: quando, result: { text: 'Ligado, vem sim' } }] });
  await varrerCalendario(unit, deps(dela.kommo, [ag()], { modo: 'aplicar' }));
  assert.deepEqual(dela.c.criadas, []);
});

test('trava anti-regravação não bloqueia correção legítima: se ALGUÉM mexeu na tarefa desde a última vez, a franquia volta a valer', async () => {
  const antes = Date.parse('2026-11-03T17:00:00Z') / 1000;
  const lista: KommoTarefa[] = [{ id: 1, text: '⚕ AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:11]', complete_till: antes, entity_id: 9 }];
  const { kommo, c } = kommoFalso(lista);
  const d = deps(kommo, [ag({ idSchedule: 11, statusName: 'CONFIRMADO' })], { modo: 'aplicar' });
  await varrerCalendario(unit, d);
  await varrerCalendario(unit, d); // Kommo não guardou: travado
  assert.equal(c.atualizadas.length, 1);
  lista[0] = { ...lista[0], text: '⚕ AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:11] alguém editou' }; // a recepção mexeu
  await varrerCalendario(unit, d);
  assert.equal(c.atualizadas.length, 2);
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
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar', resolver: async () => ({ leadId: null, confirmado: true, fone: '+5547999990000' }) }));
  assert.equal(r.semCartao, 1);
  assert.equal(r.cartaoIncerto, 0);
  assert.equal(c.criadas[0].leadId, null);
  assert.match(String(c.criadas[0].text), /\[ag:3784113\] Paciente: INGRIDE SOUZA LIMA · Tel: \+5547999990000$/);
});

test('cartão incerto (telefone casou com vários cartões): NÃO crava a tarefa no cartão da mãe/filha — vai solta', async () => {
  const { kommo, c } = kommoFalso([]);
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar', resolver: async () => ({ leadId: 555, confirmado: false, fone: '+5547999990000' }) }));
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
  assert.equal(r.criadas, 1, 'o contador só sobe para o que de fato gravou');
});

test('busca da franquia truncada: não aponta tarefa como "sumida" (a lista está incompleta)', async () => {
  const { kommo } = kommoFalso([{ id: 2, text: '⚕ SESSÃO [ag:22]', complete_till: Date.parse('2026-11-03T12:00:00Z') / 1000, entity_id: 9 }]);
  const r = await varrerCalendario(unit, deps(kommo, [], { modo: 'aplicar', buscarAgenda: async () => ({ ok: true, agendamentos: [], truncada: true }) }));
  assert.equal(r.sumiram, 0);
});

test('a recepção concluiu a tarefa de uma consulta ainda AGENDADA: respeita, não cria outra a cada ciclo', async () => {
  const { kommo, c } = kommoFalso([], { concluidas: [{ id: 5, text: '⚕ AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113]', complete_till: Date.parse('2026-11-03T17:00:00Z') / 1000, entity_id: 555 }] });
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.deepEqual(c.criadas, []);
  assert.equal(r.jaConcluidas, 1);
});

test('lista de concluídas ilegível: não cria nada novo (poderia duplicar), mas segue atualizando e fechando', async () => {
  const { kommo, c } = kommoFalso([{ id: 2, text: '⚕ SESSÃO 09:00 · AGENDADO [ag:22]', complete_till: Date.parse('2026-11-03T12:00:00Z') / 1000, entity_id: 9 }], { falhaNasConcluidas: true });
  const r = await varrerCalendario(unit, deps(kommo, [ag(), ag({ idSchedule: 22, statusName: 'ATENDIDO', idStatus: 42 })], { modo: 'aplicar' }));
  assert.deepEqual(c.criadas, []);
  assert.deepEqual(c.fechadas, [{ id: 2, resultado: 'Atendido' }]);
  assert.equal(r.erros, 1);
});

test('sem saber o tipo (429 na lista de tipos): aborta — cair no tipo 1 esconderia as tarefas já criadas e duplicaria todas', async () => {
  const { kommo, c } = kommoFalso([], { falhaNosTipos: true });
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(r.erros, 1);
  assert.deepEqual(c.criadas, []);
});

// ── várias unidades: config por unidade, cache próprio, Kommo dividido ───────────────────────────────

test('a memória de "acabei de criar" dura pelo menos 30 min (a lista do Kommo atrasa quando há várias unidades em fila)', () => {
  assert.ok(CRIADA_RECENTE_MS >= 30 * 60_000);
});

test('config da tabela vence o .env: tipo, dono e duração por unidade', async () => {
  process.env.FRANQUIA_CALENDARIO_TIPO = 'doutor-hernia-timbo:77';
  const { kommo, c } = kommoFalso([]);
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar', lerConfig: async () => ({ taskTypeId: 88, responsibleUserId: 99, duracaoMin: 30 }) }));
  assert.equal(c.criadas[0].taskTypeId, 88);
  assert.equal(c.criadas[0].responsibleUserId, 99);
  assert.equal(c.criadas[0].manterResponsavel, true);
  assert.equal(c.criadas[0].durationSec, 1800);
  assert.equal(c.tipos, 0, 'tipo configurado: nem pergunta ao Kommo');
});

test('unidade sem dono configurado: NÃO fixa o responsável — o createTask aplica a regra do único usuário da clínica (nunca o login da consultoria)', async () => {
  delete process.env.FRANQUIA_CALENDARIO_RESPONSAVEL;
  const { kommo, c } = kommoFalso([]);
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(c.criadas[0].responsibleUserId, undefined);
  assert.notEqual(c.criadas[0].manterResponsavel, true);
});

test('o tipo de uma conta não vaza para outra: cada Kommo é perguntado pelo seu "Consulta"', async () => {
  const a = kommoFalso([], { tipos: [{ id: 1, name: 'Follow-up' }, { id: 111, name: 'Consulta' }] });
  const b = kommoFalso([], { tipos: [{ id: 1, name: 'Follow-up' }, { id: 222, name: 'Consulta' }] });
  const outra = { id: 'u-serra', slug: 'doutor-hernia-serra', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
  await varrerCalendario(unit, deps(a.kommo, [ag()], { modo: 'aplicar' }));
  await varrerCalendario(outra, deps(b.kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(a.c.criadas[0].taskTypeId, 111);
  assert.equal(b.c.criadas[0].taskTypeId, 222);
});

test('Kommo dividido: a irmã marca com prefixo e só enxerga as próprias tarefas (o mesmo idSchedule da dona não se confunde)', async () => {
  const grupo: GrupoDoCrm = { contaUnitId: 'u-petro', membros: [
    { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis', slug: 'doutor-hernia-petropolis' },
    { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias', slug: 'doutor-hernia-caxias' },
  ] };
  const caxias = { id: 'u-caxias', slug: 'doutor-hernia-caxias', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
  const quando = Date.parse('2026-11-03T17:00:00Z') / 1000;
  // a lista da conta tem a tarefa da DONA para o idSchedule 3784113 — a irmã tem um agendamento com o MESMO número
  const { kommo, c } = kommoFalso([{ id: 1, text: '⚕ AVALIAÇÃO 14:00 · AGENDADO [ag:3784113]', complete_till: quando, entity_id: 9 }]);
  const r = await varrerCalendario(caxias, deps(kommo, [ag()], { modo: 'aplicar', grupo, cartaoEhDaUnidade: async () => true }));
  assert.equal(r.criadas, 1, 'a tarefa da dona não conta como a da Caxias');
  assert.equal(r.sumiram, 0, 'e a da dona não vira "sumida" para a Caxias');
  assert.match(String(c.criadas[0].text), /\[ag:caxias:3784113\]/);
  assert.deepEqual([c.atualizadas, c.fechadas], [[], []]);
  // a dona, na mesma lista, continua com o marcador de sempre e ignora a tarefa `[ag:caxias:N]`
  const petro = { id: 'u-petro', slug: 'doutor-hernia-petropolis', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
  const dona = kommoFalso([{ id: 2, text: '⚕ AVALIAÇÃO 14:00 · AGENDADO [ag:caxias:3784113]', complete_till: quando, entity_id: 9 }]);
  const rd = await varrerCalendario(petro, deps(dona.kommo, [ag()], { modo: 'aplicar', grupo, cartaoEhDaUnidade: async () => true }));
  assert.equal(rd.criadas, 1);
  assert.match(String(dona.c.criadas[0].text), /\[ag:3784113\]/);
  assert.doesNotMatch(String(dona.c.criadas[0].text), /caxias/);
});

test('Kommo dividido: cartão de OUTRA unidade (ou sem unidade) não recebe a tarefa — ela nasce solta', async () => {
  const grupo: GrupoDoCrm = { contaUnitId: 'u-petro', membros: [
    { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis', slug: 'doutor-hernia-petropolis' },
    { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias', slug: 'doutor-hernia-caxias' },
  ] };
  const caxias = { id: 'u-caxias', slug: 'doutor-hernia-caxias', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
  const { kommo, c } = kommoFalso([]);
  // sem `cartaoEhDaUnidade` injetado: usa o Kommo falso, que devolve um cartão com o campo da unidade = Petrópolis
  (kommo as unknown as { getLead: unknown }).getLead = async () => ({ id: 555, custom_fields_values: [{ field_name: '⌂ Unidade de atendimento', values: [{ value: 'Petrópolis' }] }] });
  const r = await varrerCalendario(caxias, deps(kommo, [ag()], { modo: 'aplicar', grupo }));
  assert.equal(c.criadas[0].leadId, null);
  assert.equal(r.semCartao, 1);
  // cartão que o campo diz ser da Caxias recebe
  const ok = kommoFalso([]);
  (ok.kommo as unknown as { getLead: unknown }).getLead = async () => ({ id: 555, custom_fields_values: [{ field_name: '⌂ Unidade de atendimento', values: [{ value: 'Caxias' }] }] });
  _limparMemoriaDoCalendario();
  await varrerCalendario(caxias, deps(ok.kommo, [ag()], { modo: 'aplicar', grupo }));
  assert.equal(ok.c.criadas[0].leadId, 555);
});

test('Kommo dividido: unidade sem rótulo próprio no grupo não escreve nada (não sabe quais cartões são dela)', async () => {
  const grupo: GrupoDoCrm = { contaUnitId: 'u-petro', membros: [{ unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis' }] };
  const caxias = { id: 'u-caxias', slug: 'doutor-hernia-caxias', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
  const { kommo, c } = kommoFalso([]);
  const r = await varrerCalendario(caxias, deps(kommo, [ag()], { modo: 'aplicar', grupo }));
  assert.equal(r.erros, 1);
  assert.deepEqual([c.criadas, c.atualizadas, c.fechadas], [[], [], []]);
});

test('modo seco no Kommo dividido também não escreve nada', async () => {
  const grupo: GrupoDoCrm = { contaUnitId: 'u-petro', membros: [
    { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis' }, { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias' },
  ] };
  const caxias = { id: 'u-caxias', slug: 'doutor-hernia-caxias', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
  const { kommo, c } = kommoFalso([]);
  const r = await varrerCalendario(caxias, deps(kommo, [ag()], { modo: 'seco', grupo, cartaoEhDaUnidade: async () => true }));
  assert.equal(r.criadas, 1);
  assert.deepEqual([c.criadas, c.atualizadas, c.fechadas], [[], [], []]);
});

test('rodada em faixas: respeita o paralelismo e mantém cada faixa (uma conta do Kommo) em fila', async () => {
  let ativas = 0, maximo = 0;
  const ordem: string[] = [];
  const faixas = [['a1', 'a2'], ['b1'], ['c1'], ['d1']];
  await rodarEmFaixas(faixas, 2, async (item) => {
    ativas++; maximo = Math.max(maximo, ativas);
    ordem.push(`+${item}`);
    await new Promise((r) => setTimeout(r, 5));
    ordem.push(`-${item}`);
    ativas--;
  });
  assert.equal(maximo, 2, 'nunca mais que 2 faixas ao mesmo tempo');
  assert.equal(ordem.length, 10, 'todas as unidades rodaram');
  assert.ok(ordem.indexOf('-a1') < ordem.indexOf('+a2'), 'dentro da faixa, uma de cada vez');
  await rodarEmFaixas([], 3, async () => assert.fail('sem faixas, nada roda'));
});

test('paralelismo da rodada: 3 por padrão, de 1 a 6', () => {
  assert.equal(paraleloDoCalendario(undefined), 3);
  assert.equal(paraleloDoCalendario('lixo'), 3);
  assert.equal(paraleloDoCalendario('1'), 1);
  assert.equal(paraleloDoCalendario('"2"'), 2);
  assert.equal(paraleloDoCalendario('50'), 6);
  assert.equal(paraleloDoCalendario('0'), 3);
});

test('Kommo dividido: erro passageiro ao ler o cartão (429) NÃO cria a tarefa solta — fica para a próxima varredura, sem gravar nada', async () => {
  const grupo: GrupoDoCrm = { contaUnitId: 'u-petro', membros: [
    { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis' }, { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias' },
  ] };
  const caxias = { id: 'u-caxias', slug: 'doutor-hernia-caxias', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
  const { kommo, c } = kommoFalso([]);
  let tentativas = 0;
  (kommo as unknown as { getLead: unknown }).getLead = async () => {
    if (tentativas++ === 0) throw new KommoApiError('getLead: 429', 429, null);
    return { id: 555, custom_fields_values: [{ field_name: '⌂ Unidade de atendimento', values: [{ value: 'Caxias' }] }] };
  };
  const d = deps(kommo, [ag()], { modo: 'aplicar', grupo });
  const r1 = await varrerCalendario(caxias, d);
  assert.equal(r1.erros, 1);
  assert.deepEqual(c.criadas, [], 'nada criado, nem solta');
  const r2 = await varrerCalendario(caxias, d); // a próxima varredura acha o cartão e põe a tarefa nele
  assert.equal(r2.erros, 0);
  assert.equal((c.criadas as Array<Record<string, unknown>>)[0].leadId, 555);
});

test('Kommo dividido: o cartão é lido UMA vez por varredura, mesmo com várias consultas do mesmo paciente', async () => {
  const grupo: GrupoDoCrm = { contaUnitId: 'u-petro', membros: [
    { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis' }, { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias' },
  ] };
  const caxias = { id: 'u-caxias', slug: 'doutor-hernia-caxias', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
  const { kommo } = kommoFalso([]);
  let leituras = 0;
  (kommo as unknown as { getLead: unknown }).getLead = async () => { leituras++; return { id: 555, custom_fields_values: [{ field_name: '⌂ Unidade de atendimento', values: [{ value: 'Caxias' }] }] }; };
  await varrerCalendario(caxias, deps(kommo, [ag({ idSchedule: 1 }), ag({ idSchedule: 2 }), ag({ idSchedule: 3 })], { modo: 'aplicar', grupo }));
  assert.equal(leituras, 1);
});

test('tabela unit_calendario ainda não existe (P2021): vale o .env, como antes; outro erro do banco: nada é feito', async () => {
  const { kommo, c } = kommoFalso([]);
  const semTabela = Object.assign(new Error('The table does not exist'), { code: 'P2021' });
  const r = await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar', lerConfig: async () => { throw semTabela; } }));
  assert.equal(r.criadas, 1);
  assert.equal(c.criadas[0].responsibleUserId, 15905863, 'o dono do .env');
  const { kommo: k2, c: c2 } = kommoFalso([]);
  _limparMemoriaDoCalendario();
  const r2 = await varrerCalendario(unit, deps(k2, [ag()], { modo: 'aplicar', lerConfig: async () => { throw new Error('conexão caiu'); } }));
  assert.equal(r2.erros, 1);
  assert.deepEqual(c2.criadas, []);
});

test('duas unidades no MESMO Kommo fora de um grupo: só a primeira roda, a outra é recusada (não duplica nem fecha a tarefa da outra)', () => {
  const u = (slug: string) => ({ slug });
  const { faixas, recusadas } = faixasPorConta([
    { unit: u('doutor-hernia-imperatriz'), conta: 'attiva', grupoId: null },
    { unit: u('imperatriz-resgate'), conta: 'attiva', grupoId: null },
    { unit: u('imperatriz-financeiro'), conta: 'attiva', grupoId: null },
    { unit: u('doutor-hernia-serra'), conta: 'serra', grupoId: null },
  ]);
  assert.deepEqual(faixas.map((f) => f.map((x) => x.slug)), [['doutor-hernia-imperatriz'], ['doutor-hernia-serra']]);
  assert.deepEqual(recusadas.map((r) => r.unit.slug), ['imperatriz-resgate', 'imperatriz-financeiro']);
});

test('conta dividida (Petrópolis × Caxias): as duas ficam na MESMA faixa, em fila; uma terceira fora do grupo é recusada', () => {
  const u = (slug: string) => ({ slug });
  const { faixas, recusadas } = faixasPorConta([
    { unit: u('doutor-hernia-petropolis'), conta: 'lvp', grupoId: 'g1' },
    { unit: u('petropolis-resgate'), conta: 'lvp', grupoId: null },
    { unit: u('doutor-hernia-caxias'), conta: 'lvp', grupoId: 'g1' },
  ]);
  assert.deepEqual(faixas.map((f) => f.map((x) => x.slug)), [['doutor-hernia-petropolis', 'doutor-hernia-caxias']]);
  assert.deepEqual(recusadas.map((r) => r.unit.slug), ['petropolis-resgate']);
});

test('a cota de criações por varredura só gasta com tarefa que NASCEU: 429 no meio não rouba vaga das outras', async () => {
  const { kommo, c } = kommoFalso([]);
  const agenda = Array.from({ length: 100 }, (_, i) => ag({ idSchedule: 1000 + i, clientName: `PACIENTE ${i}` }));
  let n = 0;
  const r = await varrerCalendario(unit, deps(kommo, agenda, {
    modo: 'aplicar',
    resolver: async () => { if (n++ < 5) throw new Error('429'); return { leadId: null, confirmado: true, fone: null }; },
  }));
  assert.equal(r.erros, 5);
  assert.equal(r.criadas, 80, 'as 5 que falharam não gastaram a cota de 80');
  assert.equal(c.criadas.length, 80);
  assert.equal(r.adiadas, 15);
});

test('sem dono configurado e a conta com mais de um usuário da clínica: AVISA no log (a tarefa iria para o dono do token)', async () => {
  delete process.env.FRANQUIA_CALENDARIO_RESPONSAVEL;
  const { kommo } = kommoFalso([]);
  let usuariosLidos = 0;
  (kommo as unknown as { usuariosDaClinica: unknown }).usuariosDaClinica = async () => { usuariosLidos++; return 2; };
  const avisos: string[] = [];
  const { logger } = await import('./logger.js');
  const original = logger.warn.bind(logger);
  (logger as unknown as { warn: unknown }).warn = (...a: unknown[]) => { avisos.push(String(a[a.length - 1])); };
  try {
    await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'seco' }));
    await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'seco' }));
  } finally {
    (logger as unknown as { warn: unknown }).warn = original;
  }
  assert.equal(avisos.filter((m) => /não tem UM só usuário da clínica/.test(m)).length, 1, 'avisa uma vez só');
  assert.equal(usuariosLidos, 1);
});

test('conta compartilhada fora de grupo: fica a unidade "doutor-hernia-*", mesmo que a auxiliar venha primeiro', () => {
  const u = (slug: string) => ({ slug });
  const { faixas, recusadas } = faixasPorConta([
    { unit: u('imperatriz-resgate'), conta: 'attiva', grupoId: null },
    { unit: u('doutor-hernia-imperatriz'), conta: 'attiva', grupoId: null },
  ]);
  assert.deepEqual(faixas.map((f) => f.map((x) => x.slug)), [['doutor-hernia-imperatriz']]);
  assert.deepEqual(recusadas.map((r) => r.unit.slug), ['imperatriz-resgate']);
});

test('recusa explícita do Kommo (422): a marca de "criada há pouco" é apagada e a próxima varredura tenta de novo; timeout mantém a marca', async () => {
  const { kommo, c } = kommoFalso([]);
  let n = 0;
  (kommo as unknown as { createTask: unknown }).createTask = async (a: Record<string, unknown>) => {
    if (n++ === 0) throw new KommoApiError('createTask: 422', 422, null);
    c.criadas.push(a);
    return { id: 1 };
  };
  const d = deps(kommo, [ag()], { modo: 'aplicar' });
  const r1 = await varrerCalendario(unit, d);
  assert.equal(r1.erros, 1);
  const r2 = await varrerCalendario(unit, d);
  assert.equal(r2.criadas, 1, 'tentou de novo, sem esperar 30 min');
  // timeout: a tarefa pode ter nascido; a marca segura a repetição
  _limparMemoriaDoCalendario();
  const t = kommoFalso([]);
  let m = 0;
  (t.kommo as unknown as { createTask: unknown }).createTask = async (a: Record<string, unknown>) => {
    if (m++ === 0) throw new KommoApiError('createTask: timeout', undefined, null);
    t.c.criadas.push(a);
    return { id: 1 };
  };
  const dt = deps(t.kommo, [ag()], { modo: 'aplicar' });
  await varrerCalendario(unit, dt);
  const r3 = await varrerCalendario(unit, dt);
  assert.equal(r3.criadas, 0);
});

test('rodadaSecaLimpa: só vale depois de uma varredura SECA sem erro (é o que a tela exige para passar a "ligado")', async () => {
  assert.equal(rodadaSecaLimpa(unit.slug), false, 'nunca rodou');
  const { kommo } = kommoFalso([]);
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'seco' }));
  assert.equal(rodadaSecaLimpa(unit.slug), true);
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'seco', buscarAgenda: async () => ({ ok: false, erro: 'timeout', agendamentos: [] }) }));
  assert.equal(rodadaSecaLimpa(unit.slug), false, 'a última teve erro');
  await varrerCalendario(unit, deps(kommo, [ag()], { modo: 'aplicar' }));
  assert.equal(rodadaSecaLimpa(unit.slug), false, 'a última foi com escrita');
});

test('recusa PERMANENTE do Kommo (tipo apagado, dono desativado): para depois de 3 recusas seguidas, com a pausa entre elas e um aviso só', async () => {
  const { kommo } = kommoFalso([]);
  let posts = 0;
  (kommo as unknown as { createTask: unknown }).createTask = async () => { posts++; throw new KommoApiError('createTask: 422', 422, null); };
  const agenda = Array.from({ length: 40 }, (_, i) => ag({ idSchedule: 5000 + i, clientName: `PACIENTE ${i}` }));
  const t0 = Date.now();
  const r = await varrerCalendario(unit, { ...deps(kommo, agenda, { modo: 'aplicar' }), pausaMs: 25 });
  assert.equal(posts, 3, 'só 3 POSTs, não 40 (nem 160)');
  assert.ok(Date.now() - t0 >= 70, 'a pausa vale também no erro');
  assert.equal(r.erros, 3);
  assert.equal(r.adiadas, 37);
  assert.equal(r.criadas, 0);
});

test('uma criação que deu certo zera a conta das recusas seguidas', async () => {
  const { kommo, c } = kommoFalso([]);
  let n = 0;
  (kommo as unknown as { createTask: unknown }).createTask = async (a: Record<string, unknown>) => {
    n++;
    if (n === 3 || n === 6) { c.criadas.push(a); return { id: n }; }
    throw new KommoApiError('createTask: 422', 422, null);
  };
  const agenda = Array.from({ length: 6 }, (_, i) => ag({ idSchedule: 6000 + i, clientName: `PACIENTE ${i}` }));
  const r = await varrerCalendario(unit, deps(kommo, agenda, { modo: 'aplicar' }));
  assert.equal(n, 6, 'nunca chegou a 3 recusas seguidas');
  assert.equal(r.criadas, 2);
});
