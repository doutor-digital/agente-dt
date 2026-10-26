/**
 * Trava da perda automática (item 5 da lista da Suzanne, 26/10/2026).
 *
 * Os cartões do teste são os reais: Canaã #28886952 (pagou, consulta marcada, Quente), Boa Vista #21224043 e Balsas
 * #29051316 (Morno, sem pagamento nem consulta). Sem banco nem Kommo de verdade.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { ETAPA } from './franquia-move.js';
import { fecharComoPerdido, varrerEstoques, seguradoPelaTrava, segurarNoSeco } from './parados-worker.js';
import { aplicarMovimento, type ResumoSync } from './franquia-sync-worker.js';
import { recarregarAutomacoes } from './automacoes-estado.js';
import { recusaDaPerdaDaSofia, travaDaPerdaAutomatica, type CartaoParaTrava } from './trava-perda.js';
import type { Funis } from './franquia-sync-worker.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import type { DecisaoParado } from './parados.js';

// ── banco falso: o que o "só no papel" registra e a marca de "robô pôs em PERDIDO" ──
const registradas: Array<{ kommoLeadId: number; acao: string; alvo: string }> = [];
Object.defineProperty(prisma, 'cardAlert', {
  value: { findMany: async () => [], upsert: async () => ({}) },
  configurable: true,
});
let automacoesGravadas: Array<{ automacao: string; estado: string; unit: { slug: string } }> = [];
Object.defineProperty(prisma, 'unitAutomacao', { value: { findMany: async () => automacoesGravadas }, configurable: true });
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
Object.defineProperty(prisma, 'conversation', { value: { findFirst: async () => null, findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'altaCandidato', { value: { findFirst: async () => null, findUnique: async () => null, create: async () => ({}) }, configurable: true });

const AGORA = Math.floor(Date.now() / 1000);
const DIA = 86_400;

type Campo = { field_id: number; field_name: string; values: Array<{ value: unknown }> };
const campo = (field_name: string, value: unknown, field_id = 1): Campo => ({ field_id, field_name, values: [{ value }] });

function cartaoDe(extra: { campos?: Campo[]; tags?: string[] }): CartaoParaTrava {
  return { custom_fields_values: extra.campos ?? [], _embedded: { tags: (extra.tags ?? []).map((name) => ({ name })) } };
}

// ── a regra pura ──
test('cartão neutro (sem consulta, sem pagamento, sem temperatura) não é travado: o robô segue', () => {
  assert.equal(travaDaPerdaAutomatica(cartaoDe({}), AGORA), null);
  assert.equal(travaDaPerdaAutomatica(cartaoDe({ campos: [campo('★ Qualificação (Quente/Morno/Frio)', 'Frio', 2)], tags: ['SEM RESPOSTA'] }), AGORA), null, 'Frio não segura');
});

test('Quente e Morno seguram — pelo campo ★ Qualificação ou pela etiqueta (Boa Vista #21224043 e Balsas #29051316 eram Morno)', () => {
  const q = (v: string) => cartaoDe({ campos: [campo('★ Qualificação (Quente/Morno/Frio)', v, 2)] });
  assert.deepEqual(travaDaPerdaAutomatica(q('Quente'), AGORA), { motivo: 'Quente' });
  assert.deepEqual(travaDaPerdaAutomatica(q('Morno'), AGORA), { motivo: 'Morno' });
  assert.deepEqual(travaDaPerdaAutomatica(cartaoDe({ tags: ['Quente'] }), AGORA), { motivo: 'Quente' });
  assert.deepEqual(travaDaPerdaAutomatica(cartaoDe({ tags: ['morno'] }), AGORA), { motivo: 'Morno' });
});

test('pagou segura: ✓ Consulta pg antecipado = Sim ou a etiqueta «$ · Pagou antecipado»; a FORMA escolhida («¤ Pagamento antecipado») não prova nada', () => {
  assert.deepEqual(travaDaPerdaAutomatica(cartaoDe({ campos: [campo('✓ Consulta pg antecipado', 'Sim', 3)] }), AGORA), { motivo: 'pagou o antecipado' });
  assert.deepEqual(travaDaPerdaAutomatica(cartaoDe({ tags: ['$ · Pagou antecipado'] }), AGORA), { motivo: 'pagou o antecipado' });
  assert.equal(travaDaPerdaAutomatica(cartaoDe({ campos: [campo('¤ Pagamento antecipado', 'Sim', 4)] }), AGORA), null, 'só escolheu pagar por Pix');
  assert.equal(travaDaPerdaAutomatica(cartaoDe({ campos: [campo('✓ Consulta pg antecipado', 'Não', 3)] }), AGORA), null);
  assert.equal(travaDaPerdaAutomatica(cartaoDe({ tags: ['Não pagou antecipado', 'Pagou no dia'] }), AGORA), null, 'etiqueta parecida não é a do comprovante');
});

test('consulta futura segura; passada, desmarcada ou que o paciente faltou não', () => {
  const com = (dias: number, situacao?: string) =>
    cartaoDe({ campos: [campo('◷ Data da Consulta', AGORA + dias * DIA, 5), ...(situacao ? [campo('✓ Situação da consulta', situacao, 6)] : [])] });
  assert.deepEqual(travaDaPerdaAutomatica(com(1, 'Agendado'), AGORA), { motivo: 'consulta futura no cartão' });
  assert.deepEqual(travaDaPerdaAutomatica(com(30), AGORA), { motivo: 'consulta futura no cartão' }, 'sem situação gravada: a data basta');
  assert.deepEqual(travaDaPerdaAutomatica(com(2, 'Confirmado'), AGORA), { motivo: 'consulta futura no cartão' });
  assert.equal(travaDaPerdaAutomatica(com(-2, 'Agendado'), AGORA), null, 'já passou');
  assert.equal(travaDaPerdaAutomatica(com(3, 'Desmarcado'), AGORA), null, 'a data que sobrou de uma consulta desmarcada');
  assert.equal(travaDaPerdaAutomatica(com(3, 'Não compareceu'), AGORA), null);
});

test('Canaã #28886952 (pagou, consulta marcada, Quente) — o caso da Suzanne — é travado', () => {
  const shelly = cartaoDe({
    campos: [
      campo('✓ Consulta pg antecipado', 'Sim', 3),
      campo('◷ Data da Consulta', AGORA + 2 * DIA, 5),
      campo('✓ Situação da consulta', 'Agendado', 6),
      campo('★ Qualificação (Quente/Morno/Frio)', 'Quente', 2),
    ],
    tags: ['$ · Pagou antecipado', 'SEM RESPOSTA'],
  });
  assert.deepEqual(travaDaPerdaAutomatica(shelly, AGORA), { motivo: 'consulta futura no cartão' });
});

// ── o portão por onde todo PERDIDO de código passa ──
let n = 0;
function unidade(): Unit {
  const slug = `teste-trava-perda-${++n}`;
  return { id: `u-${slug}`, slug, spineEnabled: false, spineToken: null, spineTimezone: 'America/Sao_Paulo', kommoSubdomain: 'teste' } as unknown as Unit;
}

const EM_ESPERA = { pipelineId: 1, statusId: 11 };
const funis = {
  comercialId: 1,
  tratamentoId: 2,
  status: new Map(),
  nomeDe: (_p: number, statusId: number) => (statusId === EM_ESPERA.statusId ? { funil: 'COMERCIAL', status: ETAPA.ESPERA } : null),
  idDe: (funil: string, etapa: string) => (funil === 'COMERCIAL' && etapa === ETAPA.ESPERA ? EM_ESPERA : null),
} as unknown as Funis;

function leadDe(id: number, extra: { campos?: Campo[]; tags?: string[] } = {}): KommoLead {
  return {
    id,
    name: `Cartão ${id}`,
    pipeline_id: EM_ESPERA.pipelineId,
    status_id: EM_ESPERA.statusId,
    created_at: AGORA - 200 * DIA,
    custom_fields_values: extra.campos ?? [],
    _embedded: { tags: (extra.tags ?? []).map((name, i) => ({ id: i + 1, name })), contacts: [] },
  } as unknown as KommoLead;
}

function kommoFalso(leads: KommoLead[], escritas: string[], lerFalha = false): KommoClient {
  return {
    getLead: async (id: number) => {
      if (lerFalha) throw new Error('Kommo fora (teste)');
      return leads.find((l) => l.id === id) as KommoLead;
    },
    listLossReasons: async () => [],
    createLossReason: async (name: string) => ({ id: 1, name }),
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: [] } }),
    listPipelines: async () => [],
    addTag: async () => void escritas.push('tag'),
    addLeadNote: async () => void escritas.push('nota'),
    setLeadStatus: async (leadId: number) => void escritas.push(`perdido:${leadId}`),
    updateLeadCustomFields: async () => void escritas.push('campo'),
  } as unknown as KommoClient;
}

const decisao: DecisaoParado = { para: 'PERDIDO', regra: 'teste', dias: 40, motivoPerda: 'Não deu continuidade ao atendimento' } as DecisaoParado;

beforeEach(() => {
  registradas.length = 0;
  automacoesGravadas = [];
});

test('fecharComoPerdido LIGADO: o Quente, o que pagou e o de consulta futura ficam; o neutro vai a PERDIDO', async () => {
  const unit = unidade();
  const leads = [
    leadDe(1, { campos: [campo('★ Qualificação (Quente/Morno/Frio)', 'Morno', 2)] }),
    leadDe(2, { tags: ['$ · Pagou antecipado'] }),
    leadDe(3, { campos: [campo('◷ Data da Consulta', AGORA + 3 * DIA, 5)] }),
    leadDe(4),
  ];
  const escritas: string[] = [];
  const kommo = kommoFalso(leads, escritas);
  const moveu: boolean[] = [];
  for (const l of leads) moveu.push(await fecharComoPerdido(unit, kommo, funis, l.id, ETAPA.ESPERA, decisao, false));
  assert.deepEqual(moveu, [false, false, false, true]);
  assert.deepEqual(escritas.filter((e) => e.startsWith('perdido')), ['perdido:4'], 'só o 4 chegou ao Kommo');
  assert.equal(escritas.filter((e) => e === 'tag' || e === 'nota').length, 2, 'etiqueta e nota só do 4: o travado não leva nem etiqueta de prazo');
});

test('fecharComoPerdido NO PAPEL: o travado vira «pularia PERDIDO» (troca o «moveria» antigo), o neutro continua «moveria»', async () => {
  const unit = unidade();
  const leads = [leadDe(1, { tags: ['Quente'] }), leadDe(4)];
  const escritas: string[] = [];
  const kommo = kommoFalso(leads, escritas);
  for (const l of leads) await fecharComoPerdido(unit, kommo, funis, l.id, ETAPA.ESPERA, decisao, true);
  assert.deepEqual(escritas, [], 'no papel nada é escrito no Kommo');
  assert.deepEqual(
    registradas.map((r) => `${r.kommoLeadId}:${r.acao}:${r.alvo}`).sort(),
    [`1:pularia:${ETAPA.PERDIDO}`, `4:moveria:${ETAPA.PERDIDO}`].sort(),
  );
});

test('no papel, se o Kommo não deixa reler o cartão, simula como sempre simulou (sem trava, sem quebrar)', async () => {
  const unit = unidade();
  const kommo = kommoFalso([leadDe(1, { tags: ['Quente'] })], [], true);
  assert.equal(await fecharComoPerdido(unit, kommo, funis, 1, ETAPA.ESPERA, decisao, true), false);
  assert.deepEqual(registradas.map((r) => r.acao), ['moveria']);
});

test('seguradoPelaTrava é o mesmo portão do filtro barato das varreduras: Quente fica, neutro passa', () => {
  const unit = unidade();
  assert.equal(seguradoPelaTrava(unit, 7, leadDe(7, { tags: ['Quente'] }), ETAPA.ESPERA, false, 'parados'), true);
  assert.equal(seguradoPelaTrava(unit, 8, leadDe(8), ETAPA.ESPERA, false, 'parados'), false);
});

// ── os estoques (a outra porta do worker de parados) ──
test('estoque LIGADO: AGENDADO velho que é Quente fica; o neutro do lado vai a PERDIDO', async () => {
  const AGENDADO = { pipelineId: 1, statusId: 12 };
  const funisAg = {
    comercialId: 1,
    tratamentoId: 2,
    status: new Map(),
    nomeDe: (_p: number, s: number) => (s === AGENDADO.statusId ? { funil: 'COMERCIAL', status: ETAPA.AGENDADO } : null),
    idDe: (f: string, e: string) => (f === 'COMERCIAL' && e === ETAPA.AGENDADO ? AGENDADO : null),
  } as unknown as Funis;
  const unit = unidade();
  const noAgendado = (l: KommoLead) => ({ ...l, status_id: AGENDADO.statusId }) as KommoLead;
  const leads = [noAgendado(leadDe(10, { tags: ['Quente'] })), noAgendado(leadDe(11))];
  const escritas: string[] = [];
  const base = kommoFalso(leads, escritas);
  const kommo = {
    ...base,
    listLeadsPorEtapa: async (_p: number, statusId: number, _l: number, page: number) => (page === 1 ? leads.filter((l) => l.status_id === statusId) : []),
    leadMudouEtapaDesde: async () => false,
    contatoEscreveuDesde: async () => false,
  } as unknown as KommoClient;
  const resumo: Parameters<typeof varrerEstoques>[3] = { unit: unit.slug, conta: 'teste', seco: false, avaliados: 0, candidatos: 0, movidos: 0, segurosPelaFranquia: 0, erros: 0 };
  await varrerEstoques({ unit, kommo, unidadesDaConta: [unit], agora: AGORA }, funisAg, null, resumo, false);
  assert.deepEqual(escritas.filter((e) => e.startsWith('perdido')), ['perdido:11'], 'o Quente (10) não foi fechado; o neutro (11) sim');
  assert.equal(resumo.movidos, 1);
  assert.equal(resumo.erros, 0);
});

// ── a Sofia (fechar_lead lost) ──
test('Sofia: fechar como perdido um Quente/pago/com consulta é recusado, com o motivo; o neutro passa; Kommo fora = recusa também (às cegas não)', async () => {
  const kommo = kommoFalso([leadDe(1, { campos: [campo('✓ Consulta pg antecipado', 'Sim', 3)] }), leadDe(2)], []);
  const r = await recusaDaPerdaDaSofia(kommo, 1, AGORA);
  assert.equal(r?.motivo, 'pagou o antecipado');
  assert.match(r?.texto ?? '', /não fecha como perdido/);
  assert.equal(await recusaDaPerdaDaSofia(kommo, 2, AGORA), null);
  const semLeitura = await recusaDaPerdaDaSofia(kommoFalso([], [], true), 1, AGORA);
  assert.equal(semLeitura?.motivo, 'cartão ilegível', 'não deu pra ler o cartão: não fecha às cegas');
});

test('estoque: o «dormente» Morno não gasta a cota de avaliação (travadosPelaPerda) e o neutro do lado é avaliado', async () => {
  const ENTRADA = { pipelineId: 1, statusId: 13 };
  const funisEntrada = {
    comercialId: 1,
    tratamentoId: 2,
    status: new Map([['COMERCIAL:ENTRADA', { id: ENTRADA.statusId, nome: 'Incoming leads' }]]),
    nomeDe: (_p: number, s: number) => (s === ENTRADA.statusId ? { funil: 'COMERCIAL', status: 'Incoming leads' } : null),
    idDe: () => null,
  } as unknown as Funis;
  const unit = unidade();
  const naEntrada = (l: KommoLead) => ({ ...l, status_id: ENTRADA.statusId, created_at: AGORA - 200 * DIA, updated_at: AGORA - 200 * DIA }) as KommoLead;
  const leads = [naEntrada(leadDe(20, { campos: [campo('★ Qualificação (Quente/Morno/Frio)', 'Morno', 2)] })), naEntrada(leadDe(21))];
  const kommo = {
    ...kommoFalso(leads, []),
    listLeadsPorEtapa: async (_p: number, statusId: number, _l: number, page: number) => (page === 1 ? leads.filter((l) => l.status_id === statusId) : []),
    leadMudouEtapaDesde: async () => false,
    contatoEscreveuDesde: async () => false,
  } as unknown as KommoClient;
  const resumo: Parameters<typeof varrerEstoques>[3] = { unit: unit.slug, conta: 'teste', seco: true, avaliados: 0, candidatos: 0, movidos: 0, segurosPelaFranquia: 0, erros: 0 };
  await varrerEstoques({ unit, kommo, unidadesDaConta: [unit], agora: AGORA }, funisEntrada, null, resumo, true);
  assert.equal(resumo.travadosPelaPerda, 1);
  assert.equal(resumo.avaliados, 1, 'só o neutro (21) gastou avaliação');
  assert.ok(registradas.some((r) => r.kommoLeadId === 20 && r.acao === 'pularia' && r.alvo === ETAPA.PERDIDO), 'o travado aparece como «pularia» no papel');
});

// ── a franquia-move no papel não promete um PERDIDO que o ligado não faria ──
test('franquia-move em «só no papel»: PERDIDO de cartão Quente vira «pularia»; o neutro continua «moveria»', async () => {
  const unit = unidade();
  automacoesGravadas = [{ automacao: 'franquia-move', estado: 'seco', unit: { slug: unit.slug } }];
  await recarregarAutomacoes();
  const funisPerdido = { ...(funis as object), idDe: (f: string, e: string) => (f === 'COMERCIAL' && e === ETAPA.PERDIDO ? { pipelineId: 1, statusId: 143 } : null) } as unknown as Funis;
  const leads = [leadDe(30, { tags: ['Quente'] }), leadDe(31)];
  const kommo = kommoFalso(leads, []);
  const resumo = { movimentos: 0, erros: 0, simulados: {} } as unknown as ResumoSync;
  const mov = { funil: 'COMERCIAL' as const, para: ETAPA.PERDIDO, motivo: 'desmarcou há 40 d e não remarcou', motivoPerda: 'Não remarcou' };
  for (const l of leads) await aplicarMovimento(unit, kommo, funisPerdido, l.id, mov, resumo, ETAPA.AGENDADO, l);
  assert.deepEqual(
    registradas.map((r) => `${r.kommoLeadId}:${r.acao}`).sort(),
    ['30:pularia', '31:moveria'],
  );
  assert.deepEqual(resumo.simulados, { [`${ETAPA.AGENDADO} → ${ETAPA.PERDIDO}`]: 1 }, 'só o neutro entra na contagem do «moveria»');
});

test('segurarNoSeco usa o cartão da lista (sem reler) e, sem ele, relê; leitura falhando não segura nem quebra', async () => {
  const unit = unidade();
  let leituras = 0;
  const kommo = { getLead: async () => (leituras++, leadDe(40, { tags: ['Morno'] })) } as unknown as KommoClient;
  assert.equal(await segurarNoSeco(unit, kommo, 40, ETAPA.ESPERA, 'parados', leadDe(40, { tags: ['Quente'] })), true);
  assert.equal(leituras, 0, 'com o cartão da lista não vai ao Kommo');
  assert.equal(await segurarNoSeco(unit, kommo, 40, ETAPA.ESPERA, 'parados'), true);
  assert.equal(leituras, 1);
  const quebrado = { getLead: async () => { throw new Error('429'); } } as unknown as KommoClient;
  assert.equal(await segurarNoSeco(unit, quebrado, 40, ETAPA.ESPERA, 'parados'), false);
});
