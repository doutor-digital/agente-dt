import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { SpineSchedule } from '../services/spine.service.js';
import { conferirConsultaDePe } from './consulta-em-outro-cadastro.js';

const AGORA = '2026-10-29T16:30';
const unit = { id: 'u', slug: 'x' } as unknown as Unit;

function sch(id: number, dia: string, hora: string, idStatus = 37, idTreatment: number | null = null): SpineSchedule {
  return {
    idSchedule: id, idTreatment, idStatus, statusName: 'x', clientName: null, categoryName: null, physicalTherapist: null,
    dateAttendanceUtc: null, dateAttendanceLocal: null, dayLocal: dia, timeLocal: hora, isBusy: true, requiresManualValidation: false,
  };
}
type C = { idClient: number; name: string; whatsapp: string | null; schedules: SpineSchedule[] };

const semAcento = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** A franquia falsa busca por NOME: devolve quem tem todas as palavras do termo no nome (e ignora o telefone, como a de verdade). */
function franquia(todos: C[], o: { buscaOk?: boolean; termoFalha?: string; leituraFalha?: number[]; cheia?: boolean } = {}) {
  const chamadas = { busca: [] as string[], leitura: [] as number[] };
  const f = {
    searchClients: async (_u: Unit, termo: string) => {
      chamadas.busca.push(termo);
      if (o.buscaOk === false || o.termoFalha === termo) return { ok: false, error: '500' };
      const palavras = semAcento(termo).split(' ').filter(Boolean);
      const achados = todos.filter((c) => palavras.every((w) => semAcento(c.name).split(' ').includes(w)));
      const clients = achados.map((c) => ({ idClient: c.idClient, name: c.name, whatsapp: c.whatsapp }));
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
  assert.deepEqual(chamadas.busca, []);
  assert.deepEqual(r, { consulta: null, duplicados: [], incompleta: false });
  const semNome: C = { idClient: 1, name: '  ', whatsapp: '5547991234567', schedules: [] };
  await conferirConsultaDePe(unit, pedido(semNome), f);
  assert.deepEqual(chamadas.busca, []);
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

test('a recepção escreveu o nome de outro jeito ("Ana Souza" × "Ana Christina Souza"): a busca por "primeiro último" acha o irmão', async () => {
  const a: C = { idClient: 1, name: 'Ana Christina Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-06', '16:00')] };
  const { f, chamadas } = franquia([a, b]);
  const r = await conferirConsultaDePe(unit, pedido(a), f);
  assert.deepEqual(chamadas.busca, ['Ana Christina Souza', 'Ana Souza', 'Ana']);
  assert.equal(r.consulta?.idClient, 2);
  assert.equal(r.incompleta, false);
});

test('um dos termos de busca falhou: incompleta, mesmo que os outros tenham respondido', async () => {
  const a: C = { idClient: 1, name: 'Ana Christina Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-06', '16:00')] };
  const r = await conferirConsultaDePe(unit, pedido(a), franquia([a, b], { termoFalha: 'Ana Christina Souza' }).f);
  assert.equal(r.incompleta, true);
  assert.equal(r.consulta?.idClient, 2, 'o que os outros termos acharam vale');
});

test('página cheia só conta como incompleta no nome INTEIRO; nos termos largos ("Ana") é o normal', async () => {
  const a: C = { idClient: 1, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [] };
  // nome de 2 palavras: termos "Ana Souza" (inteiro) e "Ana" — a página cheia vem nos dois, e conta só pelo primeiro
  const { f } = franquia([a], { cheia: true });
  const r = await conferirConsultaDePe(unit, pedido(a), f);
  assert.equal(r.incompleta, true);
  // se só o termo largo vier cheio, não é incompleta
  const so = {
    searchClients: async (_u: Unit, termo: string) => ({
      ok: true,
      data: { clients: termo === 'Ana' ? Array.from({ length: 100 }, (_, i) => ({ idClient: 2000 + i, name: 'Ana Lima', whatsapp: `55119${String(20000000 + i)}` })) : [{ idClient: 1, name: 'Ana Souza', whatsapp: '5547991234567' }] },
    }),
    getClient: async () => ({ ok: true, data: { client: null } }),
  };
  assert.equal((await conferirConsultaDePe(unit, pedido(a), so as never)).incompleta, false);
});
