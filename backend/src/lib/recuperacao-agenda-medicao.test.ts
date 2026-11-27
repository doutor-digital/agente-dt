import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_DA_REDE, desfechoDoItem, medirRetorno, type EventoMedido, type ItemMedido } from './recuperacao-agenda-medicao.js';

const dia = (iso: string) => new Date(`${iso}:00.000Z`);
const LISTADO = dia('2026-11-10T11:00'); // a lista saiu 10/11, 08h em São Paulo

const item = (o: Partial<ItemMedido> = {}): ItemMedido => ({ idSchedule: 1, pacienteChave: 'pA', tipo: 'desmarcou', modo: 'ligado', listadoEm: LISTADO, ...o });
const ev = (o: Partial<EventoMedido> = {}): EventoMedido => ({
  idSchedule: 2, pacienteChave: 'pA', deStatus: null, paraStatus: 37, inicioEm: dia('2026-11-17T14:00'), vistoEm: dia('2026-11-12T15:00'), ...o,
});

// ── um item ─────────────────────────────────────────────────────────────────────
test('voltou: agendamento NOVO do mesmo paciente, visto depois da lista, para o dia da lista ou depois', () => {
  const d = desfechoDoItem(item(), [ev()], 30);
  assert.deepEqual(d, { remarcou: true, compareceu: false, correcao: false });
});

test('compareceu: o agendamento novo ficou ATENDIDO depois', () => {
  const d = desfechoDoItem(item(), [ev(), ev({ deStatus: 37, paraStatus: 42, vistoEm: dia('2026-11-17T18:00') })], 30);
  assert.deepEqual(d, { remarcou: true, compareceu: true, correcao: false });
});

test('compareceu não depende da ordem dos eventos: marcou A, desmarcou A, marcou B e foi atendida em B', () => {
  const A1 = ev({ idSchedule: 21, vistoEm: dia('2026-11-11T10:00') });
  const A2 = ev({ idSchedule: 21, deStatus: 37, paraStatus: 57, vistoEm: dia('2026-11-12T10:00') });
  const B1 = ev({ idSchedule: 22, vistoEm: dia('2026-11-13T10:00'), inicioEm: dia('2026-11-18T14:00') });
  const B2 = ev({ idSchedule: 22, deStatus: 37, paraStatus: 42, vistoEm: dia('2026-11-18T18:00'), inicioEm: dia('2026-11-18T14:00') });
  const certo = [A1, A2, B1, B2];
  const embaralhado = [B2, A2, B1, A1];
  assert.deepEqual(desfechoDoItem(item(), certo, 30), { remarcou: true, compareceu: true, correcao: false });
  assert.deepEqual(desfechoDoItem(item(), embaralhado, 30), { remarcou: true, compareceu: true, correcao: false });
});

test('o atendimento só conta DENTRO da janela: o que foi atendido depois dela não infla o número com o passar do tempo', () => {
  const novo = ev({ vistoEm: dia('2026-11-12T10:00') });
  const fora = ev({ deStatus: 37, paraStatus: 42, vistoEm: dia('2026-12-20T18:00') }); // 40 dias depois da lista
  assert.deepEqual(desfechoDoItem(item(), [novo, fora], 30), { remarcou: true, compareceu: false, correcao: false });
  const dentro = ev({ deStatus: 37, paraStatus: 42, vistoEm: dia('2026-12-05T18:00') }); // 25 dias depois
  assert.deepEqual(desfechoDoItem(item(), [novo, dentro], 30), { remarcou: true, compareceu: true, correcao: false });
  // a mesma lista medida de novo, meses depois, dá o mesmo número
  const agora = dia('2027-03-01T12:00');
  assert.equal(medirRetorno([item()], [novo, fora], agora, 30).porModo.ligado.total.compareceram, 0);
});

test('o mesmo agendamento que voltou a ficar marcado para uma data futura também é volta', () => {
  const d = desfechoDoItem(item(), [ev({ idSchedule: 1, deStatus: 57, paraStatus: 41, inicioEm: dia('2026-11-20T14:00') })], 30);
  assert.equal(d.remarcou, true);
});

test('o mesmo horário que já tinha passado e foi reativado é CORREÇÃO DE REGISTRO, não retorno (a recepção arrumou o lançamento)', () => {
  const d = desfechoDoItem(item({ tipo: 'faltou' }), [ev({ idSchedule: 1, deStatus: 40, paraStatus: 42, inicioEm: dia('2026-11-08T14:00') })], 30);
  assert.deepEqual(d, { remarcou: false, compareceu: false, correcao: true });
});

test('não conta: outro paciente, evento ANTES da lista, depois da janela, status desmarcado/faltou, data passada, ou além do horizonte do sincronizador', () => {
  const casos: Array<[string, EventoMedido]> = [
    ['outro paciente', ev({ pacienteChave: 'pB' })],
    ['visto antes da lista', ev({ vistoEm: dia('2026-11-09T10:00') })],
    ['visto depois dos 30 dias', ev({ vistoEm: dia('2026-12-11T10:00') })],
    ['nasceu desmarcado', ev({ paraStatus: 57 })],
    ['data anterior à lista (lançamento atrasado)', ev({ inicioEm: dia('2026-11-05T14:00') })],
    ['marcação além de 45 dias (já existia, só entrou na janela)', ev({ inicioEm: dia('2027-01-20T14:00') })],
    ['evento de agendamento que já existia (não é a 1ª vez)', ev({ deStatus: 37 })],
  ];
  for (const [nome, e] of casos) assert.equal(desfechoDoItem(item(), [e], 30).remarcou, false, nome);
});

// ── os números ──────────────────────────────────────────────────────────────────
test('taxa só com janela completa; quem foi listado há menos de X dias está em observação e fica fora da taxa', () => {
  const agora = dia('2026-11-26T12:00'); // 16 dias depois da lista
  const itens = [item({ idSchedule: 1, pacienteChave: 'p1' }), item({ idSchedule: 2, pacienteChave: 'p2' })];
  const eventos = [ev({ pacienteChave: 'p1', idSchedule: 9 })];
  const curta = medirRetorno(itens, eventos, agora, 7).porModo.ligado;
  assert.equal(curta.total.comJanelaCompleta, 2);
  assert.equal(curta.total.remarcaram, 1);
  assert.equal(curta.total.taxaRemarcou, 0.5);
  const longa = medirRetorno(itens, eventos, agora, 30).porModo.ligado;
  assert.equal(longa.total.comJanelaCompleta, 0, 'a janela de 30 dias ainda não fechou');
  assert.equal(longa.total.emObservacao, 2);
  assert.equal(longa.total.remarcaramEmObservacao, 1);
  assert.equal(longa.total.taxaRemarcou, null, 'sem janela completa não há taxa: nunca um zero');
});

test('por modo e por grupo: «seco» (o que ninguém recebeu) separado de «ligado»; desmarque (inclui provável falta) separado de falta', () => {
  const agora = dia('2026-12-30T12:00');
  const itens = [
    item({ idSchedule: 1, pacienteChave: 'p1', tipo: 'desmarcou', modo: 'ligado' }),
    item({ idSchedule: 2, pacienteChave: 'p2', tipo: 'provavel_falta', modo: 'ligado' }),
    item({ idSchedule: 3, pacienteChave: 'p3', tipo: 'faltou', modo: 'ligado' }),
    item({ idSchedule: 4, pacienteChave: 'p4', tipo: 'desmarcou', modo: 'seco' }),
  ];
  const eventos = [ev({ pacienteChave: 'p1', idSchedule: 11 }), ev({ pacienteChave: 'p3', idSchedule: 13 }), ev({ pacienteChave: 'p3', idSchedule: 13, deStatus: 37, paraStatus: 42, vistoEm: dia('2026-11-18T10:00') })];
  const r = medirRetorno(itens, eventos, agora, 30).porModo;
  assert.equal(r.ligado.desmarque.listados, 2);
  assert.equal(r.ligado.desmarque.remarcaram, 1);
  assert.equal(r.ligado.desmarque.taxaRemarcou, 0.5);
  assert.equal(r.ligado.falta.listados, 1);
  assert.equal(r.ligado.falta.compareceram, 1);
  assert.equal(r.ligado.falta.taxaCompareceu, 1);
  assert.equal(r.seco.total.listados, 1);
  assert.equal(r.seco.total.remarcaram, 0);
  assert.equal(r.seco.total.taxaRemarcou, 0);
});

test('a base da rede (11% e 3%) vem junto, com a ressalva de que é piso', () => {
  assert.equal(BASE_DA_REDE.desmarque, 0.11);
  assert.equal(BASE_DA_REDE.falta, 0.03);
  assert.match(BASE_DA_REDE.fonte, /piso/);
});
