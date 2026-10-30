import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { SpineSchedule } from '../services/spine.service.js';
import { conferirConsultaDePe, mesmoNome } from './consulta-em-outro-cadastro.js';

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

test('escolhe a consulta de pé MAIS PRÓXIMA entre os cadastros da MESMA pessoa; empate fica com o primeiro lido', async () => {
  const a: C = { idClient: 1, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'ANA SOUZA', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-20', '10:00')] };
  const c: C = { idClient: 3, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(30, '2026-11-06', '16:00')] };
  const d: C = { idClient: 4, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(40, '2026-11-06', '16:00')] };
  const { f } = franquia([a, b, c, d]);
  const r = await conferirConsultaDePe(unit, pedido(a), f);
  assert.equal(r.consulta?.idClient, 3);
  assert.deepEqual(r.duplicados, [2, 3, 4]);
  assert.deepEqual(r.possiveisDuplicados, []);
  assert.equal(r.incompleta, false);
});

test('a consulta já está no PRÓPRIO cadastro (Bebedouro): não gasta nenhuma busca nem leitura nos irmãos', async () => {
  const a: C = { idClient: 1, name: 'Ignez Souza', whatsapp: '5547991234567', schedules: [sch(10, '2026-11-20', '10:00')] };
  const { f, chamadas } = franquia([a]);
  const r = await conferirConsultaDePe(unit, pedido(a), f);
  assert.equal(r.consulta?.idClient, 1);
  assert.deepEqual(chamadas, { busca: [], leitura: [] });
  assert.equal(r.incompleta, false);
});

// ── O sênior reprovou "nome compatível + mesmo telefone = mesmo paciente": mãe e filha dividem o WhatsApp ──
const fone = '5547991234567';
const consultaDoOutro = [sch(55, '2026-11-06', '16:00')];
for (const [rotulo, pedidoNome, outroNome] of [
  ['mãe e filha (mesmo 1º nome e sobrenome em comum)', 'Maria Eduarda da Silva', 'Maria José da Silva'],
  ['pai e filho Júnior', 'José Carlos Pereira Júnior', 'José Carlos Pereira'],
  ['cadastro só com o primeiro nome', 'Ana', 'Ana Paula Costa'],
  ['Christina × Cristina (erro de digitação OU outra pessoa: só a equipe sabe)', 'Ana Christina Rodrigues', 'ANA CRISTINA RODRIGUES'],
] as const) {
  test(`nome só compatível NÃO é o mesmo paciente: ${rotulo}`, async () => {
    const a: C = { idClient: 1, name: pedidoNome, whatsapp: fone, schedules: [] };
    const b: C = { idClient: 2, name: outroNome, whatsapp: fone, schedules: consultaDoOutro };
    const r = await conferirConsultaDePe(unit, pedido(a), franquia([a, b]).f);
    assert.equal(r.consulta, null, 'a consulta do outro NÃO é deste paciente');
    assert.deepEqual(r.duplicados, []);
    assert.equal(r.possiveisDuplicados.length, 1);
    assert.equal(r.possiveisDuplicados[0].idClient, 2);
    assert.equal(r.possiveisDuplicados[0].consulta?.schedule.idSchedule, 55, 'a equipe precisa saber que ele tem consulta');
  });
}

test('Timbó exato: nome igual, telefone com e sem o 9 → MESMO paciente', async () => {
  const a: C = { idClient: 374228, name: 'Ana Christina Rodrigues', whatsapp: '+554792919491', schedules: [] };
  const b: C = { idClient: 374234, name: 'Ana Christina Rodrigues', whatsapp: '+5547992919491', schedules: consultaDoOutro };
  const r = await conferirConsultaDePe(unit, { paciente: a, fones: ['+554792919491'], agoraLocal: AGORA }, franquia([a, b]).f);
  assert.equal(r.consulta?.idClient, 374234);
  assert.deepEqual(r.duplicados, [374234]);
  assert.deepEqual(r.possiveisDuplicados, []);
});

test('nome igual ignora caixa, acento e espaço a mais — é a mesma normalização da franquia', async () => {
  const a: C = { idClient: 1, name: 'José  da Conceição', whatsapp: fone, schedules: [] };
  const b: C = { idClient: 2, name: 'JOSE DA CONCEICAO ', whatsapp: fone, schedules: consultaDoOutro };
  const r = await conferirConsultaDePe(unit, pedido(a), franquia([a, b]).f);
  assert.equal(r.consulta?.idClient, 2);
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
  assert.deepEqual(r, { consulta: null, duplicados: [], possiveisDuplicados: [], incompleta: false });
  const semNome: C = { idClient: 1, name: '  ', whatsapp: '5547991234567', schedules: [] };
  await conferirConsultaDePe(unit, pedido(semNome), f);
  assert.deepEqual(chamadas.busca, []);
});

test('busca que falha, página cheia e cadastro irmão ilegível marcam "incompleta"', async () => {
  const a: C = { idClient: 1, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [] };
  const falha = await conferirConsultaDePe(unit, pedido(a), franquia([a, b], { buscaOk: false }).f);
  assert.equal(falha.incompleta, true);
  assert.equal(falha.consulta, null);
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

test('a recepção escreveu o nome de outro jeito ("Ana Souza" × "Ana Christina Souza"): a busca por "primeiro último" acha o parecido — como POSSÍVEL duplicado', async () => {
  const a: C = { idClient: 1, name: 'Ana Christina Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'Ana Souza', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-06', '16:00')] };
  const { f, chamadas } = franquia([a, b]);
  const r = await conferirConsultaDePe(unit, pedido(a), f);
  assert.deepEqual(chamadas.busca, ['Ana Christina Souza', 'Ana Souza', 'Ana']);
  assert.equal(r.consulta, null);
  assert.deepEqual(r.possiveisDuplicados.map((x) => x.idClient), [2]);
  assert.equal(r.incompleta, false);
});

test('um dos termos específicos falhou: incompleta, mesmo que os outros tenham respondido', async () => {
  const a: C = { idClient: 1, name: 'Ana Christina Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'Ana Christina Souza', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-06', '16:00')] };
  const r = await conferirConsultaDePe(unit, pedido(a), franquia([a, b], { termoFalha: 'Ana Christina Souza' }).f);
  assert.equal(r.incompleta, true);
  assert.equal(r.consulta?.idClient, 2, 'o que os outros termos acharam vale');
});

test('a busca LARGA (só o primeiro nome) falhar NÃO deixa a conferência incompleta; falhar a de nome inteiro de uma palavra só, sim', async () => {
  const a: C = { idClient: 1, name: 'Ana Christina Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'Ana Christina Souza', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-06', '16:00')] };
  const larga = await conferirConsultaDePe(unit, pedido(a), franquia([a, b], { termoFalha: 'Ana' }).f);
  assert.equal(larga.incompleta, false);
  assert.equal(larga.consulta?.idClient, 2);
  const uma: C = { idClient: 1, name: 'Ana', whatsapp: '5547991234567', schedules: [] };
  assert.equal((await conferirConsultaDePe(unit, pedido(uma), franquia([uma], { termoFalha: 'Ana' }).f)).incompleta, true);
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

test('3ª rodada: nome de UMA palavra ("Maria"): a página cheia no nome inteiro é o termo largo — não deixa a conferência incompleta', async () => {
  const uma: C = { idClient: 1, name: 'Maria', whatsapp: '5547991234567', schedules: [] };
  const r = await conferirConsultaDePe(unit, pedido(uma), franquia([uma], { cheia: true }).f);
  assert.equal(r.incompleta, false);
  // mas a página cheia de um nome de DUAS palavras (o termo inteiro) continua incompleta (teste acima)
});

test('3ª rodada: possível duplicado com DUAS consultas de pé — devolve as duas (a mais próxima também em `consulta`)', async () => {
  const a: C = { idClient: 1, name: 'Ana Christina Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'ANA CRISTINA SOUZA', whatsapp: '5547991234567', schedules: [sch(21, '2026-11-20', '17:00'), sch(20, '2026-11-06', '09:00')] };
  const r = await conferirConsultaDePe(unit, pedido(a), franquia([a, b]).f);
  assert.equal(r.possiveisDuplicados.length, 1);
  assert.deepEqual(r.possiveisDuplicados[0].consultas.map((c) => c.schedule.idSchedule), [20, 21]);
  assert.equal(r.possiveisDuplicados[0].consulta?.schedule.idSchedule, 20);
});

test('mesmoNome: caixa, acento e espaços não contam; nome vazio nunca é igual; Christina × Cristina não é igual', () => {
  assert.equal(mesmoNome('Ana  Christina', 'ANA CHRISTINA'), true);
  assert.equal(mesmoNome('José', 'jose'), true);
  assert.equal(mesmoNome('', null), false);
  assert.equal(mesmoNome('Ana Christina', 'Ana Cristina'), false);
});

test('cadastro criado pela IA ("IA-Ana Christina Souza"): a busca vai SEM o prefixo e acha o irmão da recepção', async () => {
  const a: C = { idClient: 1, name: 'IA-Ana Christina Souza', whatsapp: '5547991234567', schedules: [] };
  const b: C = { idClient: 2, name: 'ANA CHRISTINA SOUZA', whatsapp: '5547991234567', schedules: [sch(20, '2026-11-06', '16:00')] };
  const { f, chamadas } = franquia([a, b]);
  const r = await conferirConsultaDePe(unit, pedido(a), f);
  assert.deepEqual(chamadas.busca, ['Ana Christina Souza', 'Ana Souza', 'Ana']);
  assert.equal(r.consulta?.idClient, 2, 'IA-Ana Christina Souza = ANA CHRISTINA SOUZA');
});
