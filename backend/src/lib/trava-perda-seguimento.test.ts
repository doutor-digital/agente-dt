/**
 * «Pagou e desmarcou» não fica travado para sempre (decisão do João, 26/10, depois do #128).
 * Tarefa para a SDR do cartão + EM ESPERA uma vez; 7 dias depois da tarefa o «pagou» solta. Sem banco nem Kommo de verdade.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { ETAPA } from './franquia-move.js';
import { fecharOuSegurar, franquiaDoVinculo } from './parados-worker.js';
import { CHAVE_SEGUIMENTO_PAGOU, SEGUIMENTO_VENCE_EM_MS, textoDaTarefaPagouDesmarcou, veredictoDaTrava } from './trava-perda-seguimento.js';
import { pagouEDesmarcou, recusaDaPerdaDaSofia, travaDaPerdaAutomatica, type CartaoParaTrava } from './trava-perda.js';
import type { Funis } from './franquia-sync-worker.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import type { DecisaoParado } from './parados.js';

// ── banco falso: marcas do card_alert (a da tarefa) e o «só no papel» ──
const marcas = new Map<string, Date>();
const registradas: Array<{ kommoLeadId: number; acao: string; alvo: string }> = [];
const chaveDe = (w: { unitId_leadId_ruleKey: { unitId: string; leadId: string; ruleKey: string } }) => Object.values(w.unitId_leadId_ruleKey).join('|');
Object.defineProperty(prisma, 'cardAlert', {
  value: {
    findMany: async () => [],
    findUnique: async (a: { where: { unitId_leadId_ruleKey: { unitId: string; leadId: string; ruleKey: string } } }) => {
      const d = marcas.get(chaveDe(a.where));
      return d ? { createdAt: d } : null;
    },
    upsert: async (a: { where: { unitId_leadId_ruleKey: { unitId: string; leadId: string; ruleKey: string } }; create: { createdAt: Date } }) => {
      marcas.set(chaveDe(a.where), a.create.createdAt);
      return {};
    },
  },
  configurable: true,
});
Object.defineProperty(prisma, 'unitAutomacao', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'automacaoSimulacao', {
  value: {
    upsert: async (a: { create: { kommoLeadId: number; acao: string; alvo: string } }) => {
      registradas.push({ kommoLeadId: a.create.kommoLeadId, acao: a.create.acao, alvo: a.create.alvo });
      return {};
    },
    deleteMany: async () => ({}),
  },
  configurable: true,
});
let vinculo: { spineIdClient: number | null } | null = null;
Object.defineProperty(prisma, 'spineLeadLink', { value: { findFirst: async () => vinculo }, configurable: true });

const AGORA = Math.floor(Date.now() / 1000);
const DIA = 86_400;
type Campo = { field_id: number; field_name: string; values: Array<{ value: unknown }> };
const campo = (field_name: string, value: unknown, field_id = 1): Campo => ({ field_id, field_name, values: [{ value }] });

/** Pagou, a consulta foi desmarcada (era dia 20 do mês passado) e não há outra. */
const DESMARCADA_EM = AGORA - 10 * DIA;
function pagouDesmarcou(extra: { situacao?: string; data?: number; tags?: string[]; qualificacao?: string } = {}): CartaoParaTrava {
  const campos: Campo[] = [
    campo('✓ Consulta pg antecipado', 'Sim', 3),
    campo('◷ Data da Consulta', extra.data ?? DESMARCADA_EM, 5),
    campo('✓ Situação da consulta', extra.situacao ?? 'Desmarcado', 6),
    ...(extra.qualificacao ? [campo('★ Qualificação (Quente/Morno/Frio)', extra.qualificacao, 2)] : []),
  ];
  return { custom_fields_values: campos, _embedded: { tags: (extra.tags ?? []).map((name) => ({ name })) } };
}

test('pagouEDesmarcou: Desmarcado, ou Remarcado com a data já passada; Remarcado futuro é consulta de pé; Atendido/sem pagamento não', () => {
  assert.deepEqual(pagouEDesmarcou(pagouDesmarcou(), AGORA), { consultaDesmarcadaEm: DESMARCADA_EM });
  assert.deepEqual(pagouEDesmarcou(pagouDesmarcou({ situacao: 'Remarcado' }), AGORA), { consultaDesmarcadaEm: DESMARCADA_EM }, 'Remarcado com data passada');
  assert.equal(pagouEDesmarcou(pagouDesmarcou({ situacao: 'Remarcado', data: AGORA + 2 * DIA }), AGORA), null, 'Remarcado com data futura: o paciente vem');
  assert.equal(pagouEDesmarcou(pagouDesmarcou({ situacao: 'Atendido' }), AGORA), null);
  assert.equal(pagouEDesmarcou({ custom_fields_values: [campo('✓ Situação da consulta', 'Desmarcado', 6)] }, AGORA), null, 'não pagou');
  assert.equal(travaDaPerdaAutomatica(pagouDesmarcou(), AGORA)?.motivo, 'pagou e desmarcou');
  assert.equal(travaDaPerdaAutomatica(pagouDesmarcou({ situacao: 'Remarcado', data: AGORA + 2 * DIA }), AGORA)?.motivo, 'consulta futura no cartão');
  assert.equal(travaDaPerdaAutomatica(pagouDesmarcou(), AGORA, { pagouVenceu: true }), null, 'vencido: o pagamento não segura');
});

let n = 0;
function unidade(): Unit {
  const slug = `teste-seguimento-${++n}`;
  return { id: `u-${slug}`, slug, spineEnabled: true, spineToken: 'x', spineTimezone: 'America/Sao_Paulo', kommoSubdomain: 'teste' } as unknown as Unit;
}
const marcaAos = (unit: Unit, leadId: number, diasAtras: number) => marcas.set([unit.id, String(leadId), CHAVE_SEGUIMENTO_PAGOU].join('|'), new Date((AGORA - diasAtras * DIA) * 1000));
const temMarca = (unit: Unit, leadId: number) => marcas.has([unit.id, String(leadId), CHAVE_SEGUIMENTO_PAGOU].join('|'));

test('veredicto: sem tarefa = abrir seguimento; tarefa de 3 d = segura; de 7 d = o pagou solta (Quente/Morno ainda seguram)', async () => {
  const unit = unidade();
  const v0 = await veredictoDaTrava(unit, 1, pagouDesmarcou(), AGORA);
  assert.equal(v0?.motivo, 'pagou e desmarcou');
  assert.deepEqual(v0?.abrirSeguimento, { consultaDesmarcadaEm: DESMARCADA_EM });
  marcaAos(unit, 1, 3);
  const v3 = await veredictoDaTrava(unit, 1, pagouDesmarcou(), AGORA);
  assert.equal(v3?.motivo, 'pagou e desmarcou');
  assert.equal(v3?.abrirSeguimento, undefined, 'a tarefa já existe: não abre outra');
  marcaAos(unit, 1, 7);
  assert.equal(await veredictoDaTrava(unit, 1, pagouDesmarcou(), AGORA), null, '7 dias depois da tarefa: solta');
  assert.equal((await veredictoDaTrava(unit, 1, pagouDesmarcou({ qualificacao: 'Morno' }), AGORA))?.motivo, 'Morno', 'Morno continua segurando');
  assert.equal(SEGUIMENTO_VENCE_EM_MS, 7 * DIA * 1000);
});

// ── o portão ──
const ESPERA = { pipelineId: 1, statusId: 11 };
const QUALIF = { pipelineId: 1, statusId: 12 };
function funisDe(comEspera: boolean): Funis {
  return {
    comercialId: 1,
    tratamentoId: 2,
    status: new Map(),
    nomeDe: (_p: number, s: number) => (s === ESPERA.statusId ? { funil: 'COMERCIAL', status: ETAPA.ESPERA } : s === QUALIF.statusId ? { funil: 'COMERCIAL', status: ETAPA.QUALIFICACAO } : null),
    idDe: (f: string, e: string) => (comEspera && f === 'COMERCIAL' && e === ETAPA.ESPERA ? ESPERA : null),
  } as unknown as Funis;
}
function cartao(id: number, etapa: { pipelineId: number; statusId: number }, base: CartaoParaTrava, responsavel = 777): KommoLead {
  return { id, name: `Cartão ${id}`, pipeline_id: etapa.pipelineId, status_id: etapa.statusId, responsible_user_id: responsavel, custom_fields_values: base.custom_fields_values, _embedded: { ...base._embedded, contacts: [] } } as unknown as KommoLead;
}
function kommoFalso(lead: KommoLead, log: string[], opc: { tarefaFalha?: boolean } = {}) {
  const tarefas: Array<{ leadId: number; text: string; responsibleUserId?: number }> = [];
  const movidos: Array<{ leadId: number; statusId: number; pipelineId: number }> = [];
  const kommo = {
    getLead: async () => lead,
    listLossReasons: async () => [],
    createLossReason: async (name: string) => ({ id: 1, name }),
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: [] } }),
    listPipelines: async () => [],
    addTag: async () => void log.push('tag'),
    addLeadNote: async () => void log.push('nota'),
    setLeadStatus: async (id: number) => void log.push(`perdido:${id}`),
    updateLeadCustomFields: async () => void log.push('campo'),
    createTask: async (t: { leadId: number; text: string; responsibleUserId?: number }) => {
      if (opc.tarefaFalha) throw new Error('Kommo recusou a tarefa (teste)');
      tarefas.push(t);
      return { id: 1 };
    },
    moveStage: async (m: { leadId: number; statusId: number; pipelineId: number }) => void movidos.push(m),
  } as unknown as KommoClient;
  return { kommo, tarefas, movidos };
}
const decisao = { para: 'PERDIDO', regra: 'teste', dias: 40, motivoPerda: 'Não deu continuidade ao atendimento' } as DecisaoParado;

beforeEach(() => {
  marcas.clear();
  registradas.length = 0;
  vinculo = null;
});

test('portão LIGADO: pagou e desmarcou NÃO vai a PERDIDO — tarefa para o responsável (com a data), EM ESPERA, marca; segunda vez não repete', async () => {
  const unit = unidade();
  const lead = cartao(1, QUALIF, pagouDesmarcou(), 4242);
  const log: string[] = [];
  const { kommo, tarefas, movidos } = kommoFalso(lead, log);
  assert.equal(await fecharOuSegurar(unit, kommo, funisDe(true), 1, ETAPA.QUALIFICACAO, decisao, false), 'travado');
  assert.deepEqual(log, [], 'nada de PERDIDO, etiqueta ou nota de prazo');
  assert.equal(tarefas.length, 1);
  assert.equal(tarefas[0].responsibleUserId, 4242, 'a tarefa vai para o responsável do cartão');
  assert.match(tarefas[0].text, /Paciente pagou antecipado e desmarcou — remarcar ou combinar devolução/);
  assert.match(tarefas[0].text, new RegExp(textoDaTarefaPagouDesmarcou(DESMARCADA_EM, 'America/Sao_Paulo').split('Consulta desmarcada: ')[1].replace(/[.()/\\]/g, '\\$&')));
  assert.deepEqual(movidos, [{ leadId: 1, statusId: ESPERA.statusId, pipelineId: ESPERA.pipelineId }]);
  assert.equal(temMarca(unit, 1), true);
  // varredura seguinte: segura, sem tarefa nova nem novo movimento
  assert.equal(await fecharOuSegurar(unit, kommo, funisDe(true), 1, ETAPA.QUALIFICACAO, decisao, false), 'travado'); // o Kommo falso não muda o cartão de etapa
  assert.equal(tarefas.length, 1);
  assert.equal(movidos.length, 1);
});

test('portão LIGADO: já em EM ESPERA não move; conta sem a etapa EM ESPERA mantém onde está (só a tarefa)', async () => {
  const unit = unidade();
  const logA: string[] = [];
  const a = kommoFalso(cartao(2, ESPERA, pagouDesmarcou()), logA);
  assert.equal(await fecharOuSegurar(unit, a.kommo, funisDe(true), 2, ETAPA.ESPERA, decisao, false), 'travado');
  assert.equal(a.tarefas.length, 1);
  assert.equal(a.movidos.length, 0, 'já está em EM ESPERA');
  const b = kommoFalso(cartao(3, QUALIF, pagouDesmarcou()), []);
  assert.equal(await fecharOuSegurar(unit, b.kommo, funisDe(false), 3, ETAPA.QUALIFICACAO, decisao, false), 'travado');
  assert.equal(b.tarefas.length, 1);
  assert.equal(b.movidos.length, 0, 'a unidade não tem a etapa');
});

test('portão LIGADO: tarefa que falha não grava a marca nem move o cartão (tenta na próxima varredura)', async () => {
  const unit = unidade();
  const { kommo, tarefas, movidos } = kommoFalso(cartao(4, QUALIF, pagouDesmarcou()), [], { tarefaFalha: true });
  assert.equal(await fecharOuSegurar(unit, kommo, funisDe(true), 4, ETAPA.QUALIFICACAO, decisao, false), 'travado');
  assert.equal(tarefas.length, 0);
  assert.equal(movidos.length, 0);
  assert.equal(temMarca(unit, 4), false);
});

test('portão LIGADO: 7 dias depois da tarefa o «pagou» solta e a regra normal fecha como PERDIDO', async () => {
  const unit = unidade();
  marcaAos(unit, 5, 8);
  const log: string[] = [];
  const { kommo, tarefas } = kommoFalso(cartao(5, ESPERA, pagouDesmarcou()), log);
  assert.equal(await fecharOuSegurar(unit, kommo, funisDe(true), 5, ETAPA.ESPERA, decisao, false), 'fechou');
  assert.ok(log.includes('perdido:5'));
  assert.equal(tarefas.length, 0);
});

test('portão NO PAPEL: nada é escrito; a tela mostra «alertaria» a tarefa, «moveria» EM ESPERA e «pularia» PERDIDO', async () => {
  const unit = unidade();
  const log: string[] = [];
  const { kommo, tarefas, movidos } = kommoFalso(cartao(6, QUALIF, pagouDesmarcou()), log);
  assert.equal(await fecharOuSegurar(unit, kommo, funisDe(true), 6, ETAPA.QUALIFICACAO, decisao, true), 'travado');
  assert.deepEqual([log, tarefas, movidos], [[], [], []]);
  assert.equal(temMarca(unit, 6), false, 'no papel não grava a marca');
  assert.deepEqual(
    registradas.map((r) => `${r.acao}:${r.alvo}`).sort(),
    [`alertaria:tarefa: pagou e desmarcou`, `moveria:${ETAPA.ESPERA}`, `pularia:${ETAPA.PERDIDO}`].sort(),
  );
});

// ── Sofia ──
test('Sofia: a tarefa vai ao responsável do cartão e o texto da recusa não promete «equipe avisada» (quem abre a tarefa é que diz)', async () => {
  const lead = cartao(7, QUALIF, { custom_fields_values: [campo('◷ Data da Consulta', AGORA + 2 * DIA, 5)], _embedded: { tags: [] } }, 999);
  const kommo = { getLead: async () => lead, listPipelines: async () => [{ id: 1, name: 'COMERCIAL' }] } as never;
  const r = await recusaDaPerdaDaSofia(kommo, 7, { agoraEpoch: AGORA });
  assert.equal(r?.responsavelId, 999);
  assert.doesNotMatch(r?.texto ?? '', /foi avisada/);
});

test('franquiaDoVinculo: sem o vínculo gravado a franquia NÃO é consultada por nome/telefone (conhecido=false → a Sofia segura)', async () => {
  vinculo = null;
  const r = await franquiaDoVinculo(unidade(), 8, AGORA);
  assert.deepEqual(r, { conhecido: false, consultaFutura: false, emAndamento: false, finalizado: false });
  vinculo = { spineIdClient: null };
  assert.equal((await franquiaDoVinculo(unidade(), 8, AGORA)).conhecido, false);
});
