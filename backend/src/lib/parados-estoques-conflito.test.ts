/**
 * Estoque × trava do conflito com a franquia (auditoria da Açailândia, 20/10/2026).
 *
 * 10817222 e 10817258 estavam travados por CONFLITO_FRANQUIA (dois pacientes da franquia no mesmo telefone: a SDR
 * escolhe no widget) e mesmo assim entraram na lista do que o estoque "moveria" pra PERDIDO. Cartão travado fica
 * parado até a SDR resolver; o cartão normal do lado continua entrando. Sem banco nem Kommo de verdade.
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

// ── banco falso: marcas do conflito (card_alert) e o que o "só no papel" registra ──
type Marca = { unitId: string; leadId: string; ruleKey: string };
let marcas: Marca[] = [];
let leiturasDeMarca: Array<{ leadId?: string }> = [];
let bancoFora = false;
/** a marca que o sincronizador grava NO MEIO da varredura: só aparece na releitura do cartão */
let marcaAtrasada: Marca | null = null;
const registradas: Array<{ kommoLeadId: number; acao: string; alvo: string }> = [];

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

let n = 0;
beforeEach(() => {
  marcas = [];
  leiturasDeMarca = [];
  bancoFora = false;
  marcaAtrasada = null;
  registradas.length = 0;
});

/** Unidade nova a cada teste: o "fica por 24 h" do worker e o "não regrava em 1 h" do papel são por unidade. */
function unidade(jornadaLigada: boolean): Unit {
  const slug = `teste-estoque-conflito-${++n}`;
  process.env.CASAMENTO_JORNADA_SLUGS = jornadaLigada ? slug : '';
  return { id: `u-${slug}`, slug, spineEnabled: false, spineToken: null, spineTimezone: 'America/Sao_Paulo', kommoSubdomain: 'teste' } as unknown as Unit;
}

// ── Kommo falso: só a etapa AGENDADO; ninguém escreveu nem mudou de etapa ──
const AGENDADO = { pipelineId: 1, statusId: 11 };
const funis = {
  comercialId: 1,
  tratamentoId: null,
  status: new Map(),
  nomeDe: () => null,
  idDe: (funil: string, etapa: string) => (funil === 'COMERCIAL' && etapa === ETAPA.AGENDADO ? AGENDADO : null),
} as unknown as Funis;

function kommoFalso(leads: KommoLead[]): KommoClient {
  return {
    listLeadsPorEtapa: async (_p: number, statusId: number, _l: number, page: number) => (statusId === AGENDADO.statusId && page === 1 ? leads : []),
    leadMudouEtapaDesde: async () => false,
    contatoEscreveuDesde: async () => false,
  } as unknown as KommoClient;
}

const AGORA = Math.floor(Date.now() / 1000);
/** AGENDADO sem ◷ Data da Consulta, criado há 200 dias: o estoque fecha como PERDIDO. */
function cartao(id: number, extra: { tags?: string[]; idClient?: number } = {}): KommoLead {
  return {
    id,
    name: `Cartão ${id}`,
    pipeline_id: AGENDADO.pipelineId,
    status_id: AGENDADO.statusId,
    created_at: AGORA - 200 * 86_400,
    custom_fields_values: extra.idClient ? [{ field_id: 99, field_name: '⚙ idClient (franquia)', values: [{ value: String(extra.idClient) }] }] : [],
    _embedded: { tags: (extra.tags ?? []).map((name, i) => ({ id: i + 1, name })), contacts: [] },
  } as unknown as KommoLead;
}

async function varrer(unit: Unit, leads: KommoLead[]) {
  const resumo: Parameters<typeof varrerEstoques>[3] = { unit: unit.slug, conta: 'teste', seco: true, avaliados: 0, candidatos: 0, movidos: 0, segurosPelaFranquia: 0, erros: 0 };
  await varrerEstoques({ unit, kommo: kommoFalso(leads), unidadesDaConta: [unit], agora: AGORA }, funis, null, resumo, true);
  const acoes = (acao: string) => registradas.filter((r) => r.acao === acao).map((r) => r.kommoLeadId).sort();
  return { resumo, moveria: acoes('moveria'), pularia: acoes('pularia') };
}

test('a regra da trava: sem ⚙ idClient e com a etiqueta ou a marca; com o ⚙ (a SDR escolheu) solta', () => {
  const marcados = new Set([10817258]);
  assert.equal(cartaoTravadoNoConflito(cartao(10817222, { tags: [TAG_CONFLITO] }), null, marcados), true, 'etiqueta');
  assert.equal(cartaoTravadoNoConflito(cartao(10817258), null, marcados), true, 'só a marca no banco também trava');
  assert.equal(cartaoTravadoNoConflito(cartao(10817222, { tags: [TAG_CONFLITO] }), 370046, marcados), false, 'com ⚙ já se sabe quem é');
  assert.equal(cartaoTravadoNoConflito(cartao(10817024, { tags: ['outra'] }), null, marcados), false, 'cartão normal');
});

test('estoque: cartão em CONFLITO_FRANQUIA não entra no "moveria"; o cartão normal entra', async () => {
  const unit = unidade(true);
  marcas = [{ unitId: unit.id, leadId: '10817258', ruleKey: 'conflito-franquia:111,222' }];
  const { resumo, moveria, pularia } = await varrer(unit, [
    cartao(10817222, { tags: [TAG_CONFLITO] }), // etiqueta (e sem ⚙)
    cartao(10817258), // só a marca no banco
    cartao(10817024), // normal
  ]);
  assert.deepEqual(moveria, [10817024]);
  assert.deepEqual(pularia, [10817222, 10817258], 'no papel, a tela mostra que pularia');
  assert.equal(resumo.travadosNoConflito, 2);
  assert.equal(resumo.avaliados, 1, 'o travado nem gasta chamada de Kommo/franquia');
  assert.equal(resumo.erros, 0);
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
