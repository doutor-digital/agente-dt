import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { SpineSchedule } from '../services/spine.service.js';
import { conferirConsultaDePe, fim8 } from './consulta-em-outro-cadastro.js';

const AGORA = '2026-10-29T16:30';
const unit = { id: 'u', slug: 'x' } as unknown as Unit;

function sch(id: number, dia: string, hora: string, idStatus = 37, idTreatment: number | null = null): SpineSchedule {
  return {
    idSchedule: id, idTreatment, idStatus, statusName: 'x', clientName: null, categoryName: null, physicalTherapist: null,
    dateAttendanceUtc: null, dateAttendanceLocal: null, dayLocal: dia, timeLocal: hora, isBusy: true, requiresManualValidation: false,
  };
}
type C = { idClient: number; name: string; whatsapp: string | null; schedules: SpineSchedule[] };

function franquia(todos: C[], o: { buscaOk?: boolean; leituraFalha?: number[]; cheia?: boolean } = {}) {
  const chamadas = { busca: 0, leitura: [] as number[] };
  const f = {
    searchClients: async () => {
      chamadas.busca++;
      if (o.buscaOk === false) return { ok: false, error: '500' };
      const clients = todos.map((c) => ({ idClient: c.idClient, name: c.name, whatsapp: c.whatsapp }));
      // página cheia: o resto são homônimos de outro telefone (não são irmãos, só enchem a página)
      const enchimento = Array.from({ length: 100 - clients.length }, (_, i) => ({ idClient: 1000 + i, name: 'Ana Souza', whatsapp: `55119${String(10000000 + i)}` }));
      return { ok: true, data: { clients: o.cheia ? [...clients, ...enchimento] : clients } };
    },
    getClient: async (_u: Unit, id: number) => {
      chamadas.leitura.push(id);
      if (o.leituraFalha?.includes(id)) return { ok: false, error: 'timeout' };
      return { ok: true, data: { client: todos.find((c) => c.idClient === id) ?? null } };
    },
  };
  return { f: f as never, chamadas };
}

const pedido = (c: C) => ({ paciente: c, fones: ['+5547991234567'], agoraLocal: AGORA });

test('fim8: últimos 8 dígitos; curto demais não vale', () => {
  assert.equal(fim8('+55 (47) 99123-4567'), '91234567');
  assert.equal(fim8('1234567'), null);
  assert.equal(fim8(null), null);
});

test('escolhe a consulta de pé MAIS PRÓXIMA entre os cadastros (o pedido incluso); empate fica com o primeiro lido', async () => {
  const a: C = { idClient: 1, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(10, '2026-11-20', '10:00')] };
  const b: C = { idClient: 2, name: 'ANA SOUZA', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-06', '16:00')] };
  const c: C = { idClient: 3, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(30, '2026-11-06', '16:00')] };
  const { f } = franquia([a, b, c]);
  const r = await conferirConsultaDePe(unit, pedido(a), f);
  assert.equal(r.consulta?.idClient, 2);
  assert.deepEqual(r.duplicados, [2, 3]);
  assert.equal(r.incompleta, false);
});

test('sessão de tratamento (com idTreatment), atendida e passada não contam como consulta de pé', async () => {
  const a: C = { idClient: 1, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = {
    idClient: 2, name: 'Ana Souza', whatsapp: '5547991234567',
    schedules: [sch(1, '2026-11-06', '16:00', 37, 99), sch(2, '2026-11-06', '17:00', 42), sch(3, '2026-10-29', '09:00')],
  };
  const r = await conferirConsultaDePe(unit, pedido(a), franquia([a, b]).f);
  assert.equal(r.consulta, null);
  assert.deepEqual(r.duplicados, [2]);
});

test('sem telefone conhecido ou sem nome: nem procura', async () => {
  const semFone: C = { idClient: 1, name: 'Ana Souza', whatsapp: null, schedules: [] };
  const { f, chamadas } = franquia([semFone]);
  const r = await conferirConsultaDePe(unit, { paciente: semFone, fones: [null, undefined], agoraLocal: AGORA }, f);
  assert.equal(chamadas.busca, 0);
  assert.deepEqual(r, { consulta: null, duplicados: [], incompleta: false });
  const semNome: C = { idClient: 1, name: '  ', whatsapp: '5547991234567', schedules: [] };
  await conferirConsultaDePe(unit, pedido(semNome), f);
  assert.equal(chamadas.busca, 0);
});

test('busca que falha, página cheia e cadastro irmão ilegível marcam "incompleta" — mas a consulta do próprio cadastro ainda vale', async () => {
  const a: C = { idClient: 1, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(10, '2026-11-20', '10:00')] };
  const b: C = { idClient: 2, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [] };
  const falha = await conferirConsultaDePe(unit, pedido(a), franquia([a, b], { buscaOk: false }).f);
  assert.equal(falha.incompleta, true);
  assert.equal(falha.consulta?.idClient, 1);
  assert.equal((await conferirConsultaDePe(unit, pedido(a), franquia([a, b], { cheia: true }).f)).incompleta, true);
  assert.equal((await conferirConsultaDePe(unit, pedido(a), franquia([a, b], { leituraFalha: [2] }).f)).incompleta, true);
});

test('o telefone do lead também vale (o cadastro duplicado pode ter o número do lead e o pedido outro)', async () => {
  const a: C = { idClient: 1, name: 'Ana Souza', whatsapp: '5547900000000', schedules: [] };
  const b: C = { idClient: 2, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-06', '16:00')] };
  const r = await conferirConsultaDePe(unit, pedido(a), franquia([a, b]).f);
  assert.equal(r.consulta?.idClient, 2);
});

test('mais cadastros irmãos que o limite: lê só os primeiros e diz que ficou incompleto', async () => {
  const todos: C[] = [{ idClient: 1, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [] }];
  for (let i = 2; i <= 9; i++) todos.push({ idClient: i, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [] });
  const { f, chamadas } = franquia(todos);
  const r = await conferirConsultaDePe(unit, pedido(todos[0]), f);
  assert.equal(chamadas.leitura.length, 5);
  assert.equal(r.incompleta, true);
});
