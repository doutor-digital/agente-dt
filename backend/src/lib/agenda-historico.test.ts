import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { prisma } from './prisma.js';
import {
  _esquecerAvisoSemSegredo, apagadores, lancamentosDosDesmarques, chaveDoPaciente, purgarHistorico, retencaoDoHistoricoDias, segredoDoHistorico, eventosDaVarredura, instanteDaFranquia, registrarMudancasDaAgenda,
  type ArmazemDoHistorico, type EstadoVisto, type ItemDoHistorico, type NovoEvento,
} from './agenda-historico.js';

process.env.AGENDA_HISTORICO_SEGREDO = 'segredo-de-teste-da-agenda-0123456789abcdef';
const UNIT = { id: 'u1', slug: 'acailandia-teste' };
const item = (o: Partial<ItemDoHistorico> = {}): ItemDoHistorico => ({
  idSchedule: 100, idStatus: 37, clientName: 'MARIA APARECIDA SOUZA', categoryName: 'AVALIAÇÃO', dateAttendanceUtc: '2026-11-20T14:00:00.000Z', modifiedUtc: '2026-11-18T10:00:00Z', ...o,
});

// ── a chave do paciente: identidade sem nome ────────────────────────────────────
test('chave do paciente: 32 hex, sem o nome, igual para a mesma pessoa e diferente entre unidades', () => {
  const a = chaveDoPaciente('u1', 'MARIA APARECIDA SOUZA');
  assert.match(a!, /^[0-9a-f]{32}$/);
  assert.equal(a, chaveDoPaciente('u1', '  Maria  Aparecida Souza '), 'caixa, espaço e acento não separam a mesma pessoa');
  assert.equal(a, chaveDoPaciente('u1', 'IA-MARIA APARECIDA SOUZA'), 'o prefixo que a franquia põe em quem nasceu pela IA não conta');
  assert.notEqual(a, chaveDoPaciente('u2', 'MARIA APARECIDA SOUZA'), 'outra unidade, outra chave');
  assert.ok(!a!.includes('maria'));
  assert.equal(chaveDoPaciente('u1', ''), null);
  assert.equal(chaveDoPaciente('u1', null), null);
});

test('instante da franquia: sem fuso vale UTC (não a hora do servidor)', () => {
  assert.equal(instanteDaFranquia('2026-11-18T10:00:00')?.toISOString(), '2026-11-18T10:00:00.000Z');
  assert.equal(instanteDaFranquia('2026-11-18T10:00:00Z')?.toISOString(), '2026-11-18T10:00:00.000Z');
  assert.equal(instanteDaFranquia('2026-11-18T10:00:00-03:00')?.toISOString(), '2026-11-18T13:00:00.000Z');
  assert.equal(instanteDaFranquia('lixo'), null);
  assert.equal(instanteDaFranquia(null), null);
});

// ── o que vira evento ───────────────────────────────────────────────────────────
test('1ª vez que vê o agendamento: evento com deStatus nulo, categoria, horário e a hora do lançamento da franquia', () => {
  const [e] = eventosDaVarredura('u1', [item({ idStatus: 57 })], new Map());
  assert.equal(e.deStatus, null);
  assert.equal(e.paraStatus, 57);
  assert.equal(e.idSchedule, 100);
  assert.equal(e.categoria, 'AVALIAÇÃO');
  assert.equal(e.inicioEm.toISOString(), '2026-11-20T14:00:00.000Z');
  assert.equal(e.modificadoEm?.toISOString(), '2026-11-18T10:00:00.000Z');
  assert.equal(e.inicioAnteriorEm, null);
  assert.equal(JSON.stringify(e).includes('MARIA'), false, 'o nome do paciente não vai para o evento');
});

test('mudança de status: guarda o de antes e o de depois; sem mudança não acrescenta nada', () => {
  const antes = new Map<number, EstadoVisto>([[100, { paraStatus: 37, inicioMs: Date.parse('2026-11-20T14:00:00.000Z') }]]);
  const [e] = eventosDaVarredura('u1', [item({ idStatus: 57 })], antes);
  assert.equal(e.deStatus, 37);
  assert.equal(e.paraStatus, 57);
  assert.deepEqual(eventosDaVarredura('u1', [item({ idStatus: 37 })], antes), [], 'mesma coisa que já temos: nenhuma linha');
});

test('remarcado para outra data com o MESMO status: é evento (a data de antes fica guardada)', () => {
  const antes = new Map<number, EstadoVisto>([[100, { paraStatus: 41, inicioMs: Date.parse('2026-11-20T14:00:00.000Z') }]]);
  const [e] = eventosDaVarredura('u1', [item({ idStatus: 41, dateAttendanceUtc: '2026-11-27T14:00:00.000Z' })], antes);
  assert.equal(e.deStatus, 41);
  assert.equal(e.paraStatus, 41);
  assert.equal(e.inicioAnteriorEm?.toISOString(), '2026-11-20T14:00:00.000Z');
  assert.equal(e.inicioEm.toISOString(), '2026-11-27T14:00:00.000Z');
});

test('o que não dá para seguir fica de fora: sem id, sem nome, sem horário; e a página repetida da franquia conta uma vez', () => {
  const lista = [
    item({ idSchedule: null }), item({ idSchedule: 2, clientName: '' }), item({ idSchedule: 3, dateAttendanceUtc: null }),
    item({ idSchedule: 4 }), item({ idSchedule: 4 }),
  ];
  assert.deepEqual(eventosDaVarredura('u1', lista, new Map()).map((e) => e.idSchedule), [4]);
});

// ── registrar: a chave, o teto e o armazém ──────────────────────────────────────
function armazemFalso(ultimos: Map<number, EstadoVisto> = new Map()) {
  const gravados: NovoEvento[] = [];
  let leituras = 0;
  const armazem: ArmazemDoHistorico = {
    async ultimos() { leituras++; return ultimos; },
    async gravar(eventos) { gravados.push(...eventos); return eventos.length; },
  };
  return { armazem, gravados, leituras: () => leituras };
}

test('chave DESLIGADA: não lê nem grava nada (o comportamento é o de antes)', async () => {
  const f = armazemFalso();
  const r = await registrarMudancasDaAgenda(UNIT, [item()], { estado: 'desligado', armazem: f.armazem });
  assert.deepEqual(r, { registrados: 0, motivo: 'desligado' });
  assert.equal(f.leituras(), 0);
  assert.deepEqual(f.gravados, []);
});

test('«só no papel» e ligada registram o histórico (observação: não toca em paciente, cartão nem etapa)', async () => {
  for (const estado of ['seco', 'ligado'] as const) {
    const f = armazemFalso();
    const r = await registrarMudancasDaAgenda(UNIT, [item(), item({ idSchedule: 101 })], { estado, armazem: f.armazem });
    assert.equal(r.registrados, 2, estado);
    assert.equal(f.gravados.every((e) => e.unitId === 'u1'), true);
  }
});

test('lista TRUNCADA (a franquia tinha mais páginas que o teto): nada é registrado — o que falta não é «mudou», é «não veio»', async () => {
  const f = armazemFalso();
  const r = await registrarMudancasDaAgenda(UNIT, [item()], { estado: 'ligado', truncada: true, armazem: f.armazem });
  assert.deepEqual(r, { registrados: 0, motivo: 'incompleta' });
  assert.equal(f.leituras(), 0);
});

test('o banco falha: nunca lança (o sincronizador segue igual)', async () => {
  const armazem: ArmazemDoHistorico = { ultimos: async () => { throw new Error('banco fora'); }, gravar: async () => 0 };
  const r = await registrarMudancasDaAgenda(UNIT, [item()], { estado: 'ligado', armazem });
  assert.deepEqual(r, { registrados: 0, motivo: 'falhou' });
});

test('duas leituras ao mesmo tempo na mesma unidade: só uma grava (a outra veria o mesmo «último» e gravaria a mudança em dobro)', async () => {
  let solta!: () => void;
  const trava = new Promise<void>((ok) => (solta = ok));
  const gravados: NovoEvento[] = [];
  const armazem: ArmazemDoHistorico = {
    async ultimos() { await trava; return new Map(); },
    async gravar(e) { gravados.push(...e); return e.length; },
  };
  const a = registrarMudancasDaAgenda(UNIT, [item()], { estado: 'ligado', armazem });
  const b = await registrarMudancasDaAgenda(UNIT, [item()], { estado: 'ligado', armazem });
  assert.deepEqual(b, { registrados: 0, motivo: 'em-curso' });
  solta();
  assert.equal((await a).registrados, 1);
  assert.equal(gravados.length, 1);
});

test('a hora em que cada desmarque foi lançado vem do histórico; agendamento sem evento (ou sem a hora) fica fora do mapa', async () => {
  Object.defineProperty(prisma, '$queryRaw', {
    value: async () => [{ id_schedule: 7, modificado_em: new Date('2026-11-19T12:00:00.000Z') }, { id_schedule: 8, modificado_em: null }],
    configurable: true,
  });
  const m = await lancamentosDosDesmarques('u1', [7, 8, 9]);
  assert.equal(m.get(7)?.toISOString(), '2026-11-19T12:00:00.000Z');
  assert.equal(m.has(8), false);
  assert.equal(m.has(9), false);
  assert.equal((await lancamentosDosDesmarques('u1', [])).size, 0);
});

// ── a chave com segredo ─────────────────────────────────────────────────────────
test('a chave é HMAC com segredo: quem tem só o banco e uma lista de nomes não reverte (o SHA-256 simples da unidade + nome NÃO é a chave)', () => {
  const plano = createHash('sha256').update('u1|maria aparecida souza').digest('hex');
  const chave = chaveDoPaciente('u1', 'MARIA APARECIDA SOUZA')!;
  assert.ok(!plano.startsWith(chave), 'não é o hash simples');
  assert.notEqual(chave, chaveDoPaciente('u1', 'MARIA APARECIDA SOUZA', 'outro-segredo-diferente-com-mais-de-32-caracteres'), 'outro segredo, outra chave');
});

test('sem segredo (ou com menos de 32 caracteres) não há chave: falha fechado', () => {
  assert.equal(segredoDoHistorico({}), null);
  assert.equal(segredoDoHistorico({ AGENDA_HISTORICO_SEGREDO: 'curto' }), null);
  assert.equal(segredoDoHistorico({ AGENDA_HISTORICO_SEGREDO: 'x'.repeat(32) }), 'x'.repeat(32));
  assert.equal(chaveDoPaciente('u1', 'MARIA', null), null);
});

test('histórico SEM o segredo: não lê nem grava nada e diz por quê (uma vez)', async () => {
  const guardado = process.env.AGENDA_HISTORICO_SEGREDO;
  delete process.env.AGENDA_HISTORICO_SEGREDO;
  _esquecerAvisoSemSegredo();
  try {
    const f = armazemFalso();
    assert.deepEqual(await registrarMudancasDaAgenda(UNIT, [item()], { estado: 'ligado', armazem: f.armazem }), { registrados: 0, motivo: 'sem-segredo' });
    assert.deepEqual(await registrarMudancasDaAgenda(UNIT, [item()], { estado: 'seco', armazem: f.armazem }), { registrados: 0, motivo: 'sem-segredo' });
    assert.equal(f.leituras(), 0);
    assert.deepEqual(f.gravados, []);
  } finally {
    process.env.AGENDA_HISTORICO_SEGREDO = guardado;
  }
});

// ── a retenção ──────────────────────────────────────────────────────────────────
test('retenção: vazio = não apaga (como hoje); só vale inteiro de 120 em diante (a medição olha 90 dias depois da lista), o resto é ignorado', () => {
  assert.equal(retencaoDoHistoricoDias({}), null);
  assert.equal(retencaoDoHistoricoDias({ AGENDA_HISTORICO_RETENCAO_DIAS: '' }), null);
  assert.equal(retencaoDoHistoricoDias({ AGENDA_HISTORICO_RETENCAO_DIAS: '365' }), 365);
  assert.equal(retencaoDoHistoricoDias({ AGENDA_HISTORICO_RETENCAO_DIAS: '120' }), 120);
  assert.equal(retencaoDoHistoricoDias({ AGENDA_HISTORICO_RETENCAO_DIAS: '"180"' }), 180);
  for (const ruim of ['1', '29', '30', '119', 'abc', '-5', '150.5']) assert.equal(retencaoDoHistoricoDias({ AGENDA_HISTORICO_RETENCAO_DIAS: ruim }), null, ruim);
});

test('a purga apaga SÓ o que passou da retenção (corte = agora − N dias); sem retenção nem chama o apagador; apagador que falha não derruba os outros', async () => {
  const cortes: Date[] = [];
  const apagadores = [
    { nome: 'a', apagar: async (c: Date) => { cortes.push(c); return 3; } },
    { nome: 'b', apagar: async () => { throw new Error('banco fora'); } },
    { nome: 'c', apagar: async (c: Date) => { cortes.push(c); return 1; } },
  ];
  const agora = new Date('2026-11-26T12:00:00.000Z');
  assert.equal(await purgarHistorico(agora, { retencaoDias: null, apagadores }), null);
  assert.equal(cortes.length, 0);
  assert.deepEqual(await purgarHistorico(agora, { retencaoDias: 365, apagadores }), { a: 3, c: 1 });
  assert.equal(cortes[0].toISOString(), '2025-11-26T12:00:00.000Z');
});

test('a purga dos eventos apaga pela data da CONSULTA, não pela hora em que vimos: agendamento futuro sem mudança não perde o único evento (senão a varredura gravaria uma «1ª vez» falsa)', async () => {
  let where: unknown;
  Object.defineProperty(prisma, 'agendaStatusEvento', { value: { deleteMany: async (a: { where: unknown }) => { where = a.where; return { count: 4 }; } }, configurable: true });
  const corte = new Date('2026-07-29T12:00:00.000Z');
  assert.equal(await apagadores.find((a) => a.nome === 'eventos')!.apagar(corte), 4);
  assert.deepEqual(where, { inicioEm: { lt: corte } });
});
