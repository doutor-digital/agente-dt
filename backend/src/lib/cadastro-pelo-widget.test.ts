/**
 * "Só cadastrar na franquia" pelo widget (16/10/2026): liga o cartão ao paciente sem marcar consulta.
 *
 * O que não pode acontecer: cadastrar em dobro (a franquia não busca por telefone), cadastrar com a franquia fora
 * do ar, cadastrar no telefone de outra pessoa, ou cadastrar na franquia da cidade errada no Kommo dividido.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { SpineService } from '../services/spine.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { _semearCrmParaTeste } from './crm-compartilhado.js';
import { limparCacheEsquema } from './kommo-schema.js';
import { cadastrarPeloWidget, dddsDiferentes } from './cadastro-pelo-widget.js';
import { pacienteExistente } from './paciente-existente.js';
import { AVISO_SEM_SOBRENOME, emAndamento, marcarPeloWidget } from './marcacao-widget.js';
import { AgendaService } from '../services/agenda.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';

const SERRA = 'doutor-hernia-serra';
const PETRO = 'doutor-hernia-petropolis';
const CAXIAS = 'doutor-hernia-caxias';
const FONE = '(24) 99999-0000';
const CAMPO_IDCLIENT = 9001;

function unidade(slug: string): Unit {
  return {
    id: `u-${slug}`,
    slug,
    name: slug,
    isActive: true,
    spineEnabled: true,
    spineToken: `tok-${slug}`,
    spineTimezone: 'America/Sao_Paulo',
    spineDefaultSourceId: 7,
    kommoAccessToken: slug === CAXIAS ? null : 'tok',
    kommoSubdomain: 'teste',
  } as unknown as Unit;
}
const UNIDADES = new Map([SERRA, PETRO, CAXIAS].map((s) => [`u-${s}`, unidade(s)]));

// ── sem banco ─────────────────────────────────────────────────────────────────────────────────────────────────
let vinculoExistente: { spineIdClient: number | null; spineIdLead: number | null; nome: string | null } | null = null;
const vinculosGravados: Array<{ unitId: string; kommoLeadId: number; spineIdClient: number }> = [];
Object.defineProperty(prisma, 'unit', { value: { findUnique: async ({ where }: { where: { id: string } }) => UNIDADES.get(where.id) ?? null }, configurable: true });
Object.defineProperty(prisma, 'executionStep', { value: { create: async () => ({}) }, configurable: true });
Object.defineProperty(prisma, 'executionTrace', { value: { update: async () => ({}) }, configurable: true });
Object.defineProperty(prisma, 'spineLeadLink', {
  value: {
    findFirst: async () => vinculoExistente,
    upsert: async ({ create }: { create: { unitId: string; kommoLeadId: number; spineIdClient: number } }) => {
      vinculosGravados.push({ unitId: create.unitId, kommoLeadId: create.kommoLeadId, spineIdClient: create.spineIdClient });
      return {};
    },
  },
  configurable: true,
});

// ── franquia falsa: registra tudo; a busca devolve o que o teste mandar, por termo ──────────────────────────────
const naFranquia: string[] = [];
let buscaPorTermo: (termo: string) => { ok: boolean; clients?: Array<{ idClient: number; name: string; whatsapp: string }> };
let tokensUsados: string[] = [];
const spine = SpineService as unknown as Record<string, unknown>;
spine.searchClients = async (unit: { spineToken: string }, termo: string) => {
  naFranquia.push(`busca:${termo}`);
  tokensUsados.push(unit.spineToken);
  const r = buscaPorTermo(termo);
  return r.ok ? { ok: true, data: { clients: r.clients ?? [] } } : { ok: false, error: 'franquia fora' };
};
spine.createClient = async (unit: { spineToken: string }) => {
  naFranquia.push('createClient');
  tokensUsados.push(unit.spineToken);
  return { ok: true, data: { idClient: 555 } };
};
spine.convertLead = async () => {
  naFranquia.push('convertLead');
  return { ok: true, data: { idClient: 556 } };
};
let fichaDoPaciente: { idClient: number; name: string; whatsapp: string } | null | 'fora' = null;
spine.getClient = async () => {
  naFranquia.push('getClient');
  if (fichaDoPaciente === 'fora') return { ok: false, error: 'franquia fora' };
  return { ok: true, data: { client: fichaDoPaciente ? { ...fichaDoPaciente, schedules: [], treatments: [] } : null } };
};
for (const nome of ['createSchedule', 'createLead']) {
  spine[nome] = async () => {
    naFranquia.push(nome);
    return { ok: false, error: 'não devia chegar aqui' };
  };
}

function kommoFalso(unidadeDeAtendimento: string | null, foneDoContato = FONE, idClientNoCartao: number | null = null) {
  const escritas: string[] = [];
  const notas: string[] = [];
  const lead = (id: number): KommoLead => ({
    id,
    name: 'MARIA SOUZA 12/10',
    status_id: 1,
    pipeline_id: 1,
    custom_fields_values: [
      ...(unidadeDeAtendimento === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: unidadeDeAtendimento }] }]),
      ...(idClientNoCartao === null ? [] : [{ field_id: CAMPO_IDCLIENT, field_name: '⚙ idClient (franquia)', values: [{ value: idClientNoCartao }] }]),
    ],
    _embedded: { contacts: [{ id: 77, is_main: true }] },
  });
  const kommo = {
    getLead: async (id: number) => lead(id),
    getContactPhone: async () => foneDoContato,
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: [{ id: CAMPO_IDCLIENT, name: '⚙ idClient (franquia)' }] } }),
    listPipelines: async () => [],
    setLeadCustomFieldValue: async (_lead: number, campo: number, _tipo: string, valor: unknown) => {
      escritas.push(`campo:${campo}=${valor}`);
    },
    addLeadNote: async (_lead: number, texto: string) => {
      escritas.push('nota');
      notas.push(texto);
    },
    moveStage: async () => {
      escritas.push('MOVEU');
    },
  } as unknown as KommoClient;
  return { kommo, escritas, notas };
}

const pedido = (leadId: number) => ({ leadId, nome: 'Maria Souza', telefone: FONE });

beforeEach(() => {
  naFranquia.length = 0;
  vinculosGravados.length = 0;
  tokensUsados = [];
  vinculoExistente = null;
  buscaPorTermo = () => ({ ok: true, clients: [] });
  fichaDoPaciente = null;
  _semearCrmParaTeste([]);
  limparCacheEsquema();
});

test('widget cadastrar: paciente novo → cadastra, liga o cartão e NÃO marca nem move', async () => {
  const { kommo, escritas } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(201), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.idClient, 555);
    assert.equal(r.novoCadastro, true);
    assert.equal(r.jaLigado, false);
  }
  assert.equal(naFranquia.filter((x) => x === 'createClient').length, 1);
  assert.ok(!naFranquia.includes('createSchedule'), 'sem consulta');
  assert.deepEqual(vinculosGravados, [{ unitId: `u-${SERRA}`, kommoLeadId: 201, spineIdClient: 555 }]);
  assert.ok(escritas.includes(`campo:${CAMPO_IDCLIENT}=555`), 'grava o ⚙ idClient no cartão');
  assert.ok(escritas.includes('nota'));
  assert.ok(!escritas.includes('MOVEU'), 'não mexe na etapa');
});

test('widget cadastrar: a franquia já tem o telefone com outro nome → liga ao existente, não cria outro', async () => {
  // "Maria Souza" não acha; "Maria" acha a "MARIA APARECIDA SOUZA" com o mesmo telefone
  buscaPorTermo = (termo) => (termo === 'MARIA' || termo === 'Maria' ? { ok: true, clients: [{ idClient: 321, name: 'MARIA APARECIDA SOUZA', whatsapp: '5524999990000' }] } : { ok: true, clients: [] });
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(202), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.idClient, 321);
    assert.equal(r.novoCadastro, false);
  }
  assert.ok(!naFranquia.includes('createClient'), 'cadastro em dobro é o erro que o botão existe para evitar');
  assert.equal(vinculosGravados[0]?.spineIdClient, 321);
});

test('widget cadastrar: homônimo com OUTRO telefone não serve — cadastra o paciente certo', async () => {
  buscaPorTermo = () => ({ ok: true, clients: [{ idClient: 999, name: 'MARIA SOUZA', whatsapp: '5521988887777' }] });
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(203), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.idClient, 555);
});

test('widget cadastrar: franquia não responde à busca → recusa e não cria nada', async () => {
  buscaPorTermo = () => ({ ok: false });
  const { kommo, escritas } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(204), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'cadastro_falhou');
  assert.ok(!naFranquia.includes('createClient'));
  assert.deepEqual(escritas, []);
});

test('widget cadastrar: telefone digitado diferente do contato → recusa sem tocar na franquia', async () => {
  const { kommo } = kommoFalso(null, '(24) 98888-1111');
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(205), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'telefone_nao_bate');
  assert.deepEqual(naFranquia, []);
});

test('widget cadastrar: cartão já ligado a um paciente → responde ok sem chamar a franquia', async () => {
  vinculoExistente = { spineIdClient: 444, spineIdLead: null, nome: 'MARIA SOUZA' };
  const { kommo, escritas } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(206), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.jaLigado, true);
    assert.equal(r.idClient, 444);
  }
  assert.deepEqual(naFranquia, []);
  assert.deepEqual(escritas, []);
});

test('widget cadastrar: o lead que o espelho criou na franquia é convertido, não duplicado', async () => {
  vinculoExistente = { spineIdClient: null, spineIdLead: 8080, nome: null };
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(207), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.idClient, 556);
  assert.ok(naFranquia.includes('convertLead'));
  assert.ok(!naFranquia.includes('createClient'));
});

// ── só o primeiro nome (pedido do João, 20/10/2026) ───────────────────────────────────────────────────────────
/** `n` pacientes de outro telefone: a página da busca da franquia vem cheia com n = 100 */
const outros = (n: number) => Array.from({ length: n }, (_, i) => ({ idClient: 9000 + i, name: `MARIA ${i}`, whatsapp: '5521900000000' }));

test('widget cadastrar: só o primeiro nome → cadastra, liga o cartão e deixa o aviso na nota', async () => {
  const { kommo, escritas, notas } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), { leadId: 208, nome: 'Maria', telefone: FONE }, { kommo });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.idClient, 555);
    assert.equal(r.novoCadastro, true);
    assert.equal(r.nome, 'Maria');
    assert.equal(r.aviso, AVISO_SEM_SOBRENOME);
  }
  assert.ok(naFranquia.includes('busca:Maria'), 'procurou pelo primeiro nome antes de criar');
  assert.equal(naFranquia.filter((x) => x === 'createClient').length, 1);
  assert.deepEqual(vinculosGravados, [{ unitId: `u-${SERRA}`, kommoLeadId: 208, spineIdClient: 555 }], 'o vínculo é pelo idClient, não pelo nome');
  assert.ok(escritas.includes(`campo:${CAMPO_IDCLIENT}=555`), 'grava o ⚙ idClient no cartão');
  assert.equal(notas.length, 1);
  assert.match(notas[0], /Salvo só com o primeiro nome — complete o sobrenome na franquia quando souber\.$/);
});

test('widget cadastrar: com nome completo não há aviso', async () => {
  const { kommo, notas } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(214), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.aviso, undefined);
  assert.doesNotMatch(notas[0] ?? '', /primeiro nome/);
});

test('widget cadastrar: só o primeiro nome e o paciente já existe com o telefone → liga a ele, sem criar e sem aviso', async () => {
  buscaPorTermo = (termo) => (termo === 'Maria' ? { ok: true, clients: [{ idClient: 321, name: 'MARIA APARECIDA SOUZA', whatsapp: '5524999990000' }] } : { ok: true, clients: [] });
  const { kommo, notas } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), { leadId: 209, nome: 'Maria', telefone: FONE }, { kommo });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.idClient, 321);
    assert.equal(r.novoCadastro, false);
    assert.equal(r.nome, 'MARIA APARECIDA SOUZA', 'fica o nome que a franquia tem');
    assert.equal(r.aviso, undefined);
  }
  assert.ok(!naFranquia.includes('createClient'));
  assert.doesNotMatch(notas[0] ?? '', /primeiro nome/);
});

test('widget cadastrar: só o primeiro nome e a busca por ele veio CHEIA → recusa (o paciente pode estar fora da 1ª página)', async () => {
  buscaPorTermo = (termo) => (termo === 'Maria' ? { ok: true, clients: outros(100) } : { ok: true, clients: [] });
  const { kommo, escritas } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), { leadId: 210, nome: 'Maria', telefone: FONE }, { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.codigo, 'sem_sobrenome');
    assert.match(r.motivo, /coloque o sobrenome/);
  }
  assert.ok(!naFranquia.includes('createClient'), 'na dúvida, não cria');
  assert.deepEqual(vinculosGravados, []);
  assert.deepEqual(escritas, []);
});

test('widget cadastrar: só o primeiro nome, página CHEIA e um paciente com o telefone nela → recusa, não liga (outro pode estar fora da página)', async () => {
  // review do Codex (20/10): a mãe e a filha no mesmo WhatsApp — só uma veio na 1ª página
  const pagina = [...outros(99), { idClient: 321, name: 'MARIA APARECIDA SOUZA', whatsapp: '5524999990000' }];
  buscaPorTermo = (termo) => (termo === 'Maria' ? { ok: true, clients: pagina } : { ok: true, clients: [] });
  const { kommo, escritas } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), { leadId: 217, nome: 'Maria', telefone: FONE }, { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'sem_sobrenome');
  assert.ok(!naFranquia.includes('createClient'));
  assert.deepEqual(vinculosGravados, [], 'não liga o cartão no chute');
  assert.deepEqual(escritas, []);
});

test('widget cadastrar: nome completo com o primeiro nome lotado na busca segue como antes (o nome inteiro prova)', async () => {
  buscaPorTermo = (termo) => (termo.toUpperCase() === 'MARIA' ? { ok: true, clients: outros(100) } : { ok: true, clients: [] });
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(211), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.idClient, 555);
});

test('widget cadastrar: primeiro nome de 2 letras não dá para buscar → recusa em vez de criar às cegas', async () => {
  // a franquia só busca com 3+ letras: "Lu" nem é procurado (o título do cartão é outro nome)
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), { leadId: 212, nome: 'Lu', telefone: FONE }, { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'sem_sobrenome');
  assert.ok(!naFranquia.includes('busca:Lu'));
  assert.ok(!naFranquia.includes('createClient'));
});

test('widget cadastrar: sem nome nenhum → recusa antes da franquia', async () => {
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), { leadId: 213, nome: '  ', telefone: FONE }, { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'sem_nome');
  assert.deepEqual(naFranquia, []);
});

test('widget cadastrar: só o primeiro nome NÃO dispensa o telefone — vazio ou de outro contato recusa sem tocar na franquia', async () => {
  const { kommo } = kommoFalso(null);
  const vazio = await cadastrarPeloWidget(unidade(SERRA), { leadId: 215, nome: 'Maria', telefone: '' }, { kommo });
  assert.equal(vazio.ok, false);
  if (!vazio.ok) assert.equal(vazio.codigo, 'telefone_incompleto');
  const outro = await cadastrarPeloWidget(unidade(SERRA), { leadId: 216, nome: 'Maria', telefone: '(24) 98888-1111' }, { kommo });
  assert.equal(outro.ok, false);
  if (!outro.ok) assert.equal(outro.codigo, 'telefone_nao_bate');
  assert.deepEqual(naFranquia, []);
});

// ── Kommo dividido (Petrópolis + Caxias) ──────────────────────────────────────────────────────────────────────
const MEMBROS = [
  { unitId: `u-${PETRO}`, contaUnitId: `u-${PETRO}`, rotulo: 'Petrópolis', slug: PETRO },
  { unitId: `u-${CAXIAS}`, contaUnitId: `u-${PETRO}`, rotulo: 'Caxias', slug: CAXIAS },
];

test('widget cadastrar: cartão de Caxias na conta de Petrópolis cadastra na franquia de CAXIAS', async () => {
  _semearCrmParaTeste(MEMBROS);
  const { kommo } = kommoFalso('Caxias');
  const r = await cadastrarPeloWidget(unidade(PETRO), pedido(301), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.unidade, 'Caxias');
  assert.ok(tokensUsados.length > 0 && tokensUsados.every((t) => t === `tok-${CAXIAS}`), 'busca e cadastro com o token de Caxias');
  assert.equal(vinculosGravados[0]?.unitId, `u-${CAXIAS}`, 'o vínculo é da unidade do cartão');
});

test('widget cadastrar: cartão sem ⌂ Unidade de atendimento no Kommo dividido → recusa sem tocar na franquia', async () => {
  _semearCrmParaTeste(MEMBROS);
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(PETRO), pedido(302), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.codigo, 'sem_unidade');
    assert.doesNotMatch(r.motivo, /marcado/, 'a frase fala de cadastro, não de marcação');
  }
  assert.deepEqual(naFranquia, []);
});

test('widget cadastrar: sem a divisão gravada, cartão de Caxias segue barrado pela trava', async () => {
  const { kommo } = kommoFalso('Caxias');
  const r = await cadastrarPeloWidget(unidade(PETRO), pedido(303), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'unidade_de_outra_cidade');
  assert.deepEqual(naFranquia, []);
});

test('pacienteExistente: junta TODOS os termos antes de decidir (é assim que aparece o segundo paciente do mesmo telefone)', async () => {
  buscaPorTermo = (termo) => (termo.toUpperCase() === 'MARIA SOUZA' ? { ok: true, clients: [{ idClient: 11, name: 'MARIA SOUZA', whatsapp: '24999990000' }] } : { ok: true, clients: [] });
  const r = await pacienteExistente(unidade(SERRA), 'Maria Souza', 'MARIA SOUZA 12/10', '5524999990000');
  assert.deepEqual(r, { tipo: 'achou', idClient: 11, nome: 'MARIA SOUZA' });
  assert.ok(naFranquia.length >= 2, 'não para no primeiro termo');
});

test('widget cadastrar: com o "Marcar" em andamento no mesmo cartão, recusa sem tocar na franquia', async () => {
  const { kommo } = kommoFalso(null);
  const u = unidade(SERRA);
  emAndamento.add(`${u.id}:209`);
  try {
    const r = await cadastrarPeloWidget(u, pedido(209), { kommo });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, 'em_andamento');
    assert.deepEqual(naFranquia, []);
  } finally {
    emAndamento.delete(`${u.id}:209`);
  }
});

// ── achados da revisão de 16/10 ───────────────────────────────────────────────────────────────────────────────
test('widget cadastrar: UMA busca falhou e as outras não acharam → recusa (o termo que falhou era o que acharia)', async () => {
  buscaPorTermo = (termo) => (termo.toUpperCase() === 'MARIA SOUZA' ? { ok: false } : { ok: true, clients: [] });
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(401), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'cadastro_falhou');
  assert.ok(!naFranquia.includes('createClient'));
});

test('widget cadastrar: dois pacientes com o mesmo telefone e nenhum com o nome igual → recusa, ninguém escolhe no chute', async () => {
  buscaPorTermo = () => ({ ok: true, clients: [
    { idClient: 21, name: 'MARIA APARECIDA LIMA', whatsapp: '5524999990000' },
    { idClient: 22, name: 'JOANA LIMA', whatsapp: '24999990000' },
  ] });
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(402), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'paciente_ambiguo');
  assert.ok(!naFranquia.includes('createClient'));
  assert.deepEqual(vinculosGravados, []);
});

test('widget cadastrar: dois com o mesmo telefone, um com o nome igual → liga a esse e devolve o nome da franquia', async () => {
  buscaPorTermo = () => ({ ok: true, clients: [
    { idClient: 31, name: 'MARIA SOUZA LIMA', whatsapp: '5524999990000' },
    { idClient: 32, name: 'MARIA SOUZA', whatsapp: '24999990000' },
  ] });
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(403), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.idClient, 32);
    assert.equal(r.nome, 'MARIA SOUZA');
  }
});

test('widget cadastrar: o cartão já tem ⚙ idClient com o mesmo telefone → liga a ele sem buscar nem criar', async () => {
  fichaDoPaciente = { idClient: 777, name: 'MARIA SOUZA DA SILVA', whatsapp: '5524999990000' };
  const { kommo } = kommoFalso(null, FONE, 777);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(404), { kommo });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.idClient, 777);
    assert.equal(r.novoCadastro, false);
    assert.equal(r.nome, 'MARIA SOUZA DA SILVA');
  }
  assert.deepEqual(naFranquia, ['getClient']);
});

test('widget cadastrar: o ⚙ idClient do cartão é de OUTRO telefone → recusa, não cria por cima', async () => {
  fichaDoPaciente = { idClient: 778, name: 'OUTRA PESSOA', whatsapp: '5521911112222' };
  const { kommo } = kommoFalso(null, FONE, 778);
  const r = await cadastrarPeloWidget(unidade(SERRA), pedido(405), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'paciente_ambiguo');
  assert.ok(!naFranquia.includes('createClient'));
});

test('widget cadastrar: DDD digitado diferente do contato → recusa (o número digitado é o que vai para o cadastro)', async () => {
  const { kommo } = kommoFalso(null, '(24) 99999-0000');
  const r = await cadastrarPeloWidget(unidade(SERRA), { leadId: 406, nome: 'Maria Souza', telefone: '(21) 99999-0000' }, { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'telefone_nao_bate');
  assert.deepEqual(naFranquia, []);
  assert.equal(dddsDiferentes('5524999990000', '(24) 99999-0000'), false);
  assert.equal(dddsDiferentes('99999-0000', '(21) 99999-0000'), false, 'sem DDD num dos lados não dá para comparar');
});

// ── "Só cadastrar" e depois "Marcar": o Marcar usa o paciente já ligado ────────────────────────────────────────
function agendaLivre() {
  const agenda = AgendaService as unknown as Record<string, unknown>;
  const reconc = AgendaReconcileService as unknown as Record<string, unknown>;
  const antes = { build: agenda.buildAgenda, consulta: reconc.consultaDoLead, sched: spine.searchSchedules, criar: spine.createSchedule };
  agenda.buildAgenda = () => [{ time: '09:00', status: 'livre' }];
  reconc.consultaDoLead = async () => null;
  spine.searchSchedules = async () => ({ ok: true, data: { schedules: [] } });
  const marcadas: number[] = [];
  spine.createSchedule = async (_u: unknown, a: { idClient: number }) => {
    naFranquia.push('createSchedule');
    marcadas.push(a.idClient);
    return { ok: true, data: { idSchedule: 9090 } };
  };
  Object.defineProperty(prisma, 'agendaBlock', { value: { findMany: async () => [] }, configurable: true });
  const desfazer = () => {
    agenda.buildAgenda = antes.build;
    reconc.consultaDoLead = antes.consulta;
    spine.searchSchedules = antes.sched;
    spine.createSchedule = antes.criar;
  };
  return { marcadas, desfazer };
}
const amanha = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

test('widget marcar: cartão já ligado pelo "Só cadastrar" → marca NESSE paciente, sem buscar nem criar outro', async () => {
  vinculoExistente = { spineIdClient: 444, spineIdLead: null, nome: 'MARIA SOUZA' };
  const { marcadas, desfazer } = agendaLivre();
  try {
    const { kommo } = kommoFalso(null);
    const r = await marcarPeloWidget(unidade(SERRA), { leadId: 501, nome: 'Maria de Souza', telefone: FONE, data: amanha(), hora: '09:00' }, { kommo });
    assert.equal(r.ok, true);
    assert.deepEqual(marcadas, [444]);
    assert.ok(!naFranquia.some((x) => x.startsWith('busca:')), 'não busca por nome');
    assert.ok(!naFranquia.includes('createClient'));
  } finally {
    desfazer();
  }
});

test('widget marcar: busca do paciente falhou em parte → recusa sem criar paciente nem marcar', async () => {
  buscaPorTermo = (termo) => (termo.toUpperCase() === 'MARIA SOUZA' ? { ok: false } : { ok: true, clients: [] });
  const { marcadas, desfazer } = agendaLivre();
  try {
    const { kommo } = kommoFalso(null);
    const r = await marcarPeloWidget(unidade(SERRA), { leadId: 502, nome: 'Maria Souza', telefone: FONE, data: amanha(), hora: '09:00' }, { kommo });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, 'cadastro_falhou');
    assert.deepEqual(marcadas, []);
    assert.ok(!naFranquia.includes('createClient'));
  } finally {
    desfazer();
  }
});

test('widget marcar: só o primeiro nome → cadastra, marca e deixa o aviso na nota', async () => {
  const { marcadas, desfazer } = agendaLivre();
  try {
    const { kommo, notas } = kommoFalso(null);
    const r = await marcarPeloWidget(unidade(SERRA), { leadId: 503, nome: 'Maria', telefone: FONE, data: amanha(), hora: '09:00' }, { kommo });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.novoCadastro, true);
      assert.equal(r.nome, 'Maria');
      assert.equal(r.aviso, AVISO_SEM_SOBRENOME);
    }
    assert.deepEqual(marcadas, [555]);
    assert.equal(vinculosGravados[0]?.spineIdClient, 555, 'o vínculo é pelo idClient');
    assert.ok(notas.some((n) => n.endsWith(AVISO_SEM_SOBRENOME)));
  } finally {
    desfazer();
  }
});

test('widget marcar: só o primeiro nome e a busca por ele veio CHEIA → recusa sem criar paciente nem marcar', async () => {
  buscaPorTermo = (termo) => (termo === 'Maria' ? { ok: true, clients: outros(100) } : { ok: true, clients: [] });
  const { marcadas, desfazer } = agendaLivre();
  try {
    const { kommo } = kommoFalso(null);
    const r = await marcarPeloWidget(unidade(SERRA), { leadId: 504, nome: 'Maria', telefone: FONE, data: amanha(), hora: '09:00' }, { kommo });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.codigo, 'sem_sobrenome');
      assert.match(r.motivo, /Nada foi marcado/);
    }
    assert.deepEqual(marcadas, []);
    assert.ok(!naFranquia.includes('createClient'));
  } finally {
    desfazer();
  }
});
