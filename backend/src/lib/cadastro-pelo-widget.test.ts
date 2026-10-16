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
import { cadastrarPeloWidget, pacienteExistente } from './cadastro-pelo-widget.js';

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
for (const nome of ['createSchedule', 'createLead']) {
  spine[nome] = async () => {
    naFranquia.push(nome);
    return { ok: false, error: 'não devia chegar aqui' };
  };
}

function kommoFalso(unidadeDeAtendimento: string | null, foneDoContato = FONE) {
  const escritas: string[] = [];
  const lead = (id: number): KommoLead => ({
    id,
    name: 'MARIA SOUZA 12/10',
    status_id: 1,
    pipeline_id: 1,
    custom_fields_values:
      unidadeDeAtendimento === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: unidadeDeAtendimento }] }],
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
    addLeadNote: async () => {
      escritas.push('nota');
    },
    moveStage: async () => {
      escritas.push('MOVEU');
    },
  } as unknown as KommoClient;
  return { kommo, escritas };
}

const pedido = (leadId: number) => ({ leadId, nome: 'Maria Souza', telefone: FONE });

beforeEach(() => {
  naFranquia.length = 0;
  vinculosGravados.length = 0;
  tokensUsados = [];
  vinculoExistente = null;
  buscaPorTermo = () => ({ ok: true, clients: [] });
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

test('widget cadastrar: sem sobrenome → recusa antes da franquia', async () => {
  const { kommo } = kommoFalso(null);
  const r = await cadastrarPeloWidget(unidade(SERRA), { leadId: 208, nome: 'Maria', telefone: FONE }, { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'sem_sobrenome');
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

test('pacienteExistente: tenta do nome mais específico ao mais largo e para no primeiro telefone que bate', async () => {
  // o título do cartão vem primeiro ("MARIA SOUZA 12/10" vira "MARIA SOUZA"), e já acha
  buscaPorTermo = (termo) => (termo.toUpperCase() === 'MARIA SOUZA' ? { ok: true, clients: [{ idClient: 11, name: 'MARIA SOUZA', whatsapp: '24999990000' }] } : { ok: true, clients: [] });
  const r = await pacienteExistente(unidade(SERRA), 'Maria Souza', 'MARIA SOUZA 12/10', '5524999990000');
  assert.deepEqual(r, { idClient: 11, nome: 'MARIA SOUZA' });
  assert.deepEqual(naFranquia, ['busca:MARIA SOUZA'], 'achou na primeira busca, não faz as outras');
});
