/**
 * Estoque × trava do conflito com a franquia (auditoria da Açailândia, 20/10/2026).
 *
 * 10817222 e 10817258 estavam travados por CONFLITO_FRANQUIA (dois pacientes da franquia no mesmo telefone: a SDR
 * escolhe no widget) e mesmo assim entraram na lista do que o estoque "moveria" pra PERDIDO. Cartão travado fica
 * parado até a SDR resolver — nem PERDIDO, nem fila da /alta, no papel ou ligado; o cartão normal do lado continua
 * entrando. Sem banco nem Kommo de verdade.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { TAG_CONFLITO, cartaoTravadoNoConflito } from './casamento-jornada.js';
import { ETAPA } from './franquia-move.js';
import { varrerEstoques } from './parados-worker.js';
import type { Funis } from './franquia-sync-worker.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';

// ── banco falso: marcas do conflito (card_alert), a fila da /alta e o que o "só no papel" registra ──
type Marca = { unitId: string; leadId: string; ruleKey: string };
let marcas: Marca[] = [];
let leiturasDeMarca: Array<{ leadId?: string }> = [];
let bancoFora = false;
/** a marca que o sincronizador grava NO MEIO da varredura: só aparece na releitura do cartão */
let marcaAtrasada: Marca | null = null;
/** cartões que ganham a etiqueta CONFLITO_FRANQUIA no meio da varredura: só aparece quando o cartão é relido no Kommo */
let tagAtrasada = new Set<number>();
const registradas: Array<{ kommoLeadId: number; acao: string; alvo: string }> = [];
const naFila: number[] = [];

const where = (a: unknown) => (a as { where: { unitId: { in: string[] }; leadId?: string; ruleKey: { startsWith: string } } }).where;
Object.defineProperty(prisma, 'cardAlert', {
  value: {
    findMany: async (args: unknown) => {
      const w = where(args);
      leiturasDeMarca.push({ leadId: w.leadId });
      if (bancoFora) throw new Error('banco fora (teste)');
      const todas = w.leadId && marcaAtrasada ? [...marcas, marcaAtrasada] : marcas;
      return todas
        .filter((m) => w.unitId.in.includes(m.unitId) && m.ruleKey.startsWith(w.ruleKey.startsWith) && (!w.leadId || m.leadId === w.leadId))
        .map((m) => ({ leadId: m.leadId }));
    },
    upsert: async () => ({}), // "o robô pôs em PERDIDO" (anotarRoboPos), no modo ligado
  },
  configurable: true,
});
Object.defineProperty(prisma, 'unitAutomacao', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'automacaoSimulacao', {
  value: {
    upsert: async (args: { create: { kommoLeadId: number; acao: string; alvo: string } }) => {
      registradas.push({ kommoLeadId: args.create.kommoLeadId, acao: args.create.acao, alvo: args.create.alvo });
      return {};
    },
    deleteMany: async () => ({}),
  },
  configurable: true,
});
Object.defineProperty(prisma, 'altaCandidato', {
  value: {
    findFirst: async () => null,
    findUnique: async () => null,
    create: async (args: { data: { leadId: number } }) => {
      naFila.push(args.data.leadId);
      return {};
    },
  },
  configurable: true,
});

let n = 0;
beforeEach(() => {
  marcas = [];
  leiturasDeMarca = [];
  bancoFora = false;
  marcaAtrasada = null;
  tagAtrasada = new Set();
  registradas.length = 0;
  naFila.length = 0;
});

/** Unidade nova a cada teste: o "fica por 24 h" do worker e o "não regrava em 1 h" do papel são por unidade. */
function unidade(jornadaLigada: boolean): Unit {
  const slug = `teste-estoque-conflito-${++n}`;
  process.env.CASAMENTO_JORNADA_SLUGS = jornadaLigada ? slug : '';
  return { id: `u-${slug}`, slug, spineEnabled: false, spineToken: null, spineTimezone: 'America/Sao_Paulo', kommoSubdomain: 'teste' } as unknown as Unit;
}

// ── Kommo falso: AGENDADO (vai a PERDIDO) e EM TRATAMENTO (vai à fila da /alta); ninguém escreveu nem mudou de etapa ──
const AGENDADO = { pipelineId: 1, statusId: 11 };
const EM_TRATAMENTO = { pipelineId: 2, statusId: 21 };
const funis = {
  comercialId: 1,
  tratamentoId: 2,
  status: new Map(),
  nomeDe: (pipelineId: number, statusId: number) =>
    statusId === AGENDADO.statusId ? { funil: 'COMERCIAL', status: ETAPA.AGENDADO } : statusId === EM_TRATAMENTO.statusId ? { funil: 'TRATAMENTO', status: ETAPA.EM_TRATAMENTO } : null,
  idDe: (funil: string, etapa: string) =>
    funil === 'COMERCIAL' && etapa === ETAPA.AGENDADO ? AGENDADO : funil === 'TRATAMENTO' && etapa === ETAPA.EM_TRATAMENTO ? EM_TRATAMENTO : null,
} as unknown as Funis;

function kommoFalso(leads: KommoLead[], movidos: number[]): KommoClient {
  return {
    listLeadsPorEtapa: async (_p: number, statusId: number, _l: number, page: number) => (page === 1 ? leads.filter((l) => l.status_id === statusId) : []),
    leadMudouEtapaDesde: async () => false,
    contatoEscreveuDesde: async () => false,
    // só o modo ligado chega aqui: relê o cartão, motivo de perda, etiqueta, status, nota
    getLead: async (id: number) => {
      const l = leads.find((x) => x.id === id) as KommoLead;
      if (!tagAtrasada.has(id)) return l;
      return { ...l, _embedded: { ...l._embedded, tags: [...(l._embedded?.tags ?? []), { id: 9, name: TAG_CONFLITO }] } };
    },
    listLossReasons: async () => [],
    createLossReason: async (name: string) => ({ id: 1, name }),
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: [] } }),
    listPipelines: async () => [],
    addTag: async () => ({}),
    addLeadNote: async () => ({}),
    setLeadStatus: async (leadId: number) => void movidos.push(leadId),
  } as unknown as KommoClient;
}

const AGORA = Math.floor(Date.now() / 1000);
/** Sem ◷ Data da Consulta nem dado de sessão, criado há 200 dias: AGENDADO vai a PERDIDO, EM TRATAMENTO à fila da /alta. */
function cartao(id: number, extra: { tags?: string[]; idClient?: number; etapa?: typeof AGENDADO } = {}): KommoLead {
  const etapa = extra.etapa ?? AGENDADO;
  return {
    id,
    name: `Cartão ${id}`,
    pipeline_id: etapa.pipelineId,
    status_id: etapa.statusId,
    created_at: AGORA - 200 * 86_400,
    custom_fields_values: extra.idClient ? [{ field_id: 99, field_name: '⚙ idClient (franquia)', values: [{ value: String(extra.idClient) }] }] : [],
    _embedded: { tags: (extra.tags ?? []).map((name, i) => ({ id: i + 1, name })), contacts: [] },
  } as unknown as KommoLead;
}

async function varrer(unit: Unit, leads: KommoLead[], seco = true) {
  const movidos: number[] = [];
  const resumo: Parameters<typeof varrerEstoques>[3] = { unit: unit.slug, conta: 'teste', seco, avaliados: 0, candidatos: 0, movidos: 0, segurosPelaFranquia: 0, erros: 0 };
  await varrerEstoques({ unit, kommo: kommoFalso(leads, movidos), unidadesDaConta: [unit], agora: AGORA }, funis, null, resumo, seco);
  const acoes = (acao: string) => registradas.filter((r) => r.acao === acao).map((r) => r.kommoLeadId).sort();
  return { resumo, moveria: acoes('moveria'), alertaria: acoes('alertaria'), pularia: acoes('pularia'), movidos: movidos.sort(), fila: [...naFila].sort() };
}

test('a regra da trava: sem ⚙ idClient e com a etiqueta ou a marca; com o ⚙ (a SDR escolheu) solta', () => {
  const marcados = new Set([10817258]);
  assert.equal(cartaoTravadoNoConflito(cartao(10817222, { tags: [TAG_CONFLITO] }), null, marcados), true, 'etiqueta');
  assert.equal(cartaoTravadoNoConflito(cartao(10817258), null, marcados), true, 'só a marca no banco também trava');
  assert.equal(cartaoTravadoNoConflito(cartao(10817222, { tags: [TAG_CONFLITO] }), 370046, marcados), false, 'com ⚙ já se sabe quem é');
  assert.equal(cartaoTravadoNoConflito(cartao(10817024, { tags: ['outra'] }), null, marcados), false, 'cartão normal');
});

test('estoque no papel: cartão em CONFLITO_FRANQUIA não entra no "moveria" nem no "alertaria"; os normais entram', async () => {
  const unit = unidade(true);
  marcas = [
    { unitId: unit.id, leadId: '10817258', ruleKey: 'conflito-franquia:111,222' },
    { unitId: unit.id, leadId: '10850692', ruleKey: 'conflito-franquia:333,444' },
  ];
  const { resumo, moveria, alertaria, pularia } = await varrer(unit, [
    cartao(10817222, { tags: [TAG_CONFLITO] }), // etiqueta (e sem ⚙)
    cartao(10817258), // só a marca no banco
    cartao(10817024), // normal
    cartao(10850692, { etapa: EM_TRATAMENTO }), // travado em EM TRATAMENTO
    cartao(10850846, { etapa: EM_TRATAMENTO }), // normal em EM TRATAMENTO
  ]);
  assert.deepEqual(moveria, [10817024]);
  assert.deepEqual(alertaria, [10850846], 'fila da /alta só o normal');
  assert.deepEqual(pularia, [10817222, 10817258, 10850692], 'no papel, a tela mostra que pularia');
  assert.equal(resumo.travadosNoConflito, 3);
  assert.equal(resumo.avaliados, 2, 'o travado nem gasta chamada de Kommo/franquia');
  assert.equal(resumo.erros, 0);
});

test('estoque ligado: o travado não vai a PERDIDO nem à fila da /alta; os normais vão', async () => {
  const unit = unidade(true);
  marcas = [{ unitId: unit.id, leadId: '10850692', ruleKey: 'conflito-franquia:333,444' }];
  const { movidos, fila, pularia, resumo } = await varrer(
    unit,
    [cartao(10817222, { tags: [TAG_CONFLITO] }), cartao(10817024), cartao(10850692, { etapa: EM_TRATAMENTO }), cartao(10850846, { etapa: EM_TRATAMENTO })],
    false,
  );
  assert.deepEqual(movidos, [10817024], 'só o normal foi fechado como PERDIDO');
  assert.deepEqual(fila, [10850846], 'só o normal entrou na fila da /alta');
  assert.deepEqual(pularia, [], 'ligado: só o log, nada na tela do papel');
  assert.equal(resumo.travadosNoConflito, 2);
  assert.equal(resumo.movidos, 2);
});

test('estoque: com ⚙ idClient (a SDR já escolheu) o cartão segue o estoque, mesmo com a etiqueta', async () => {
  const unit = unidade(true);
  const { moveria } = await varrer(unit, [cartao(10850692, { tags: [TAG_CONFLITO], idClient: 370046 })]);
  assert.deepEqual(moveria, [10850692]);
});

test('estoque: a marca que aparece no meio da varredura também segura (releitura antes de mexer)', async () => {
  const unit = unidade(true);
  marcaAtrasada = { unitId: unit.id, leadId: '10817222', ruleKey: 'conflito-franquia:111,222' };
  const { moveria, pularia, resumo } = await varrer(unit, [cartao(10817222), cartao(10817024)]);
  assert.deepEqual(moveria, [10817024]);
  assert.deepEqual(pularia, [10817222]);
  assert.equal(resumo.candidatos, 1);
  assert.ok(leiturasDeMarca.some((l) => l.leadId === '10817222'), 'releu a marca do cartão');
});

test('estoque ligado: a etiqueta posta no meio da varredura (sem marca no banco) também segura — achado do Codex', async () => {
  const unit = unidade(true);
  tagAtrasada = new Set([10817222]);
  const { movidos, resumo } = await varrer(unit, [cartao(10817222), cartao(10817024)], false);
  assert.deepEqual(movidos, [10817024], 'relê o cartão no Kommo antes de mexer');
  assert.equal(resumo.travadosNoConflito, 1);
});

test('estoque: banco fora na leitura das travas = o estoque não roda nesta varredura', async () => {
  const unit = unidade(true);
  bancoFora = true;
  const { moveria, resumo } = await varrer(unit, [cartao(10817222, { tags: [TAG_CONFLITO] }), cartao(10817024)]);
  assert.deepEqual(moveria, []);
  assert.equal(resumo.avaliados, 0);
  assert.equal(resumo.erros, 1);
});

test('estoque: com a chave casamento-jornada fora de "ligado" a trava não vale (igual ao sincronizador)', async () => {
  const unit = unidade(false);
  marcas = [{ unitId: unit.id, leadId: '10817258', ruleKey: 'conflito-franquia:111,222' }];
  const { moveria } = await varrer(unit, [cartao(10817222, { tags: [TAG_CONFLITO] }), cartao(10817258)]);
  assert.deepEqual(moveria, [10817222, 10817258]);
  assert.equal(leiturasDeMarca.length, 0, 'nem lê o banco');
});
