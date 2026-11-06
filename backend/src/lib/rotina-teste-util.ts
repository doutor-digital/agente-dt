/**
 * Material de teste da rotina diária dos robôs: banco, Kommo e franquia FALSOS. Não é um teste (não termina em `.test.ts`); o
 * importam os testes do núcleo, do motor do silêncio e de cada régua. Idêntico nos PRs.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import type { KommoLead } from '../services/kommo.service.js';
import type { Funis } from './franquia-sync-worker.js';
import type { NaFranquia } from './parados-worker.js';
import { ETAPA, TRATAMENTO_EM_ANDAMENTO } from './franquia-move.js';
import { configBase, _limparCacheDaRotina, type Ctx } from './rotina-nucleo.js';

// ── tempo ──
export const AGORA = Date.UTC(2026, 10, 6, 13, 0, 0) / 1000; // 10h em Brasília, sexta
export const DIA = 86_400;
export const H = 3600;

// ── banco falso ──
export interface Traco {
  id: string;
  unitId: string;
  leadId: string;
  createdAt: Date;
}
export const tracos = new Map<string, Traco>();
export const conversas = new Map<string, number>();
export const pausados = new Set<number>();
export const simulacoes: Array<{ unitId: string; automacao: string; kommoLeadId: number; acao: string; alvo: string; deEtapa: string | null; valor: string | null; motivo: string | null }> = [];

const bate = (t: Traco, where: Record<string, unknown>): boolean => {
  if (where.unitId && t.unitId !== where.unitId) return false;
  const lead = where.leadId as { in?: string[] } | undefined;
  if (lead?.in && !lead.in.includes(t.leadId)) return false;
  const id = where.id as { startsWith?: string; in?: string[] } | string | undefined;
  if (typeof id === 'object' && id?.startsWith && !t.id.startsWith(id.startsWith)) return false;
  if (typeof id === 'object' && id?.in && !id.in.includes(t.id)) return false;
  const quando = where.createdAt as { gte?: Date } | undefined;
  if (quando?.gte && t.createdAt < quando.gte) return false;
  return true;
};
Object.defineProperty(prisma, 'executionTrace', {
  value: {
    findMany: async (a: { where: Record<string, unknown> }) => [...tracos.values()].filter((t) => bate(t, a.where)),
    create: async (a: { data: { id: string; unitId: string; leadId: string } }) => {
      if (tracos.has(a.data.id)) throw new Error('Unique constraint failed');
      tracos.set(a.data.id, { id: a.data.id, unitId: a.data.unitId, leadId: a.data.leadId, createdAt: new Date(AGORA * 1000) });
      return {};
    },
    delete: async (a: { where: { id: string } }) => {
      tracos.delete(a.where.id);
      return {};
    },
  },
  configurable: true,
});
Object.defineProperty(prisma, 'conversation', {
  value: { findMany: async (a: { where: { leadId: { in: string[] } } }) => a.where.leadId.in.filter((id) => conversas.has(id)).map((leadId) => ({ leadId, lastMessageAt: new Date((conversas.get(leadId) as number) * 1000) })) },
  configurable: true,
});
Object.defineProperty(prisma, 'leadPausa', {
  value: { findUnique: async (a: { where: { unitId_kommoLeadId: { kommoLeadId: number } } }) => (pausados.has(a.where.unitId_kommoLeadId.kommoLeadId) ? { ate: new Date((AGORA + DIA) * 1000) } : null) },
  configurable: true,
});
Object.defineProperty(prisma, 'automacaoSimulacao', {
  value: { upsert: async (a: { create: (typeof simulacoes)[number] }) => void simulacoes.push(a.create), deleteMany: async () => ({}) },
  configurable: true,
});
Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });
Object.defineProperty(prisma, 'unitAutomacao', { value: { findMany: async () => [] }, configurable: true });

/** Uma marca da rotina (ou de outro robô) no banco falso. `h` = há quantas horas ela saiu. */
export function poeMarca(id: string, unitId: string, leadId: number | string, haHoras = 0): void {
  tracos.set(id, { id, unitId, leadId: String(leadId), createdAt: new Date((AGORA - haHoras * H) * 1000) });
}

// ── funis ──
export const COM = 1;
export const TRAT = 2;
export const PERDIDO: [number, number] = [COM, 143];
const STATUS: Record<string, { pipelineId: number; statusId: number }> = {
  [`COMERCIAL:${ETAPA.QUALIFICACAO}`]: { pipelineId: COM, statusId: 11 },
  [`COMERCIAL:${ETAPA.NAO_COMPARECEU}`]: { pipelineId: COM, statusId: 12 },
  [`COMERCIAL:${ETAPA.NEGOCIACAO}`]: { pipelineId: COM, statusId: 13 },
  [`COMERCIAL:${ETAPA.ESPERA}`]: { pipelineId: COM, statusId: 14 },
  [`COMERCIAL:${ETAPA.AGENDADO}`]: { pipelineId: COM, statusId: 15 },
  [`TRATAMENTO:${ETAPA.EM_TRATAMENTO}`]: { pipelineId: TRAT, statusId: 21 },
  [`TRATAMENTO:${ETAPA.ALTA}`]: { pipelineId: TRAT, statusId: 22 },
};
const NOMES: Record<string, string> = { '1:11': ETAPA.QUALIFICACAO, '1:12': ETAPA.NAO_COMPARECEU, '1:13': ETAPA.NEGOCIACAO, '1:14': ETAPA.ESPERA, '1:15': ETAPA.AGENDADO, '1:143': ETAPA.PERDIDO, '2:21': ETAPA.EM_TRATAMENTO, '2:22': ETAPA.ALTA };
export const funis = {
  comercialId: COM,
  tratamentoId: TRAT,
  status: new Map(),
  nomeDe: (p: number, s: number) => (NOMES[`${p}:${s}`] ? { funil: p === TRAT ? 'TRATAMENTO' : 'COMERCIAL', status: NOMES[`${p}:${s}`] } : null),
  idDe: (funil: string, etapa: string) => STATUS[`${funil}:${etapa}`] ?? null,
} as unknown as Funis;

// ── Kommo falso ──
let n = 0;
export interface CartaoFalso {
  lead: KommoLead;
  contato: number;
  /** última mensagem do paciente (epoch s); null = nunca escreveu */
  paciente: number | null;
  /** falas do chat oficial */
  falas: Array<{ autor: 'external' | 'bot' | 'user'; em: number }>;
  /** quando entrou na etapa (epoch s) — o evento lead_status_changed; null = o Kommo não soube dizer */
  entrouNaEtapa: number | null;
}
export const cartoes: CartaoFalso[] = [];
export const chamadas: string[] = [];
export const tagsNoKommo = new Map<number, string[]>();
/** os outros cartões de um contato (para o «voltou em outro cartão» do ex-lead) e os modelos da conta */
export const extrasDoKommo = { outrosDoContato: [] as KommoLead[], modelos: [] as Array<{ name: string; _embedded?: { reviews?: Array<{ status?: string }> } }> };

export function campos(c: Record<string, unknown>): KommoLead['custom_fields_values'] {
  return Object.entries(c).map(([nome, value], i) => ({ field_id: 5000 + i, field_name: nome, values: [{ value }] })) as KommoLead['custom_fields_values'];
}

export function novo(
  opts: { etapa?: [number, number]; silencioDias?: number | null; tags?: string[]; campos?: Record<string, unknown>; falas?: CartaoFalso['falas']; nome?: string; closed?: number; contato?: number; entrou?: number | null; created?: number } = {},
): CartaoFalso {
  const id = 1000 + ++n;
  const [pipeline_id, status_id] = opts.etapa ?? [COM, 11];
  const contato = opts.contato ?? 50_000 + id;
  const lead = {
    id,
    name: opts.nome ?? `Paciente ${id}`,
    pipeline_id,
    status_id,
    updated_at: AGORA - n,
    created_at: opts.created ?? AGORA - 400 * DIA,
    closed_at: opts.closed,
    custom_fields_values: campos(opts.campos ?? {}),
    _embedded: { tags: (opts.tags ?? []).map((name, i) => ({ id: i + 1, name })), contacts: [{ id: contato, is_main: true }] },
  } as unknown as KommoLead;
  const c: CartaoFalso = {
    lead,
    contato,
    paciente: opts.silencioDias === null ? null : AGORA - (opts.silencioDias ?? 3) * DIA,
    falas: opts.falas ?? [],
    entrouNaEtapa: opts.entrou === undefined ? AGORA - 100 * DIA : opts.entrou,
  };
  if (c.paciente !== null) c.falas.push({ autor: 'external', em: c.paciente });
  tagsNoKommo.set(id, opts.tags ?? []);
  cartoes.push(c);
  return c;
}

export const kommo = {
  listLeadsPorEtapa: async (pipelineId: number, statusId: number, _l?: number, page = 1) => (page > 1 ? [] : cartoes.filter((c) => c.lead.pipeline_id === pipelineId && c.lead.status_id === statusId).map((c) => c.lead)),
  ultimaMensagemDoContatoDesde: async (contato: number, desde: number) => {
    chamadas.push(`mensagem:${contato}`);
    const c = cartoes.find((x) => x.contato === contato);
    return c?.paciente != null && c.paciente >= desde ? c.paciente : null;
  },
  ultimaMudancaDeEtapa: async (leadId: number) => cartoes.find((c) => c.lead.id === leadId)?.entrouNaEtapa ?? null,
  listTalks: async (leadId: number) => (cartoes.find((c) => c.lead.id === leadId)?.falas.length ? [{ talk_id: leadId, updated_at: AGORA }] : []),
  listTalkMessages: async (talkId: number) =>
    (cartoes.find((c) => c.lead.id === talkId)?.falas ?? []).map((f, i) => ({ id: `m${i}`, type: 'x', text: 'oi', created_at: f.em, author: { type: f.autor, name: f.autor } })),
  listLeadsPorIds: async (ids: number[]) => cartoes.filter((c) => ids.includes(c.lead.id)).map((c) => c.lead),
  getLead: async (leadId: number) => {
    const c = cartoes.find((x) => x.lead.id === leadId) as CartaoFalso;
    return { ...c.lead, _embedded: { ...c.lead._embedded, tags: (tagsNoKommo.get(leadId) ?? []).map((name, i) => ({ id: i + 1, name })) } } as KommoLead;
  },
  addTag: async (p: { leadId: number; tag?: string }) => {
    chamadas.push(`addTag:${p.leadId}:${p.tag}`);
    tagsNoKommo.set(p.leadId, [...(tagsNoKommo.get(p.leadId) ?? []), p.tag as string]);
  },
  removeTag: async (leadId: number, tag: string) => {
    chamadas.push(`removeTag:${leadId}:${tag}`);
    tagsNoKommo.set(leadId, (tagsNoKommo.get(leadId) ?? []).filter((t) => t !== tag));
  },
  addLeadNote: async (leadId: number) => {
    chamadas.push(`nota:${leadId}`);
    return {};
  },
  // usados só pela trava do ex-lead (`voltouEmOutroCartao`) e pelos modelos da conta
  leadsDoContato: async (contato: number) => {
    const ids = cartoes.filter((c) => c.contato === contato).map((c) => c.lead.id);
    return [...ids, ...extrasDoKommo.outrosDoContato.map((l) => l.id)];
  },
  listChatTemplates: async () => extrasDoKommo.modelos,
};
export const kommoDoCtx = kommo as unknown as Ctx['kommo'];

export const escritas = () => chamadas.filter((c) => /^(addTag|removeTag|nota)/.test(c));
export const tagsPostas = () => chamadas.filter((c) => c.startsWith('addTag')).map((c) => c.split(':').slice(2).join(':'));
export const leadsComTag = () => chamadas.filter((c) => c.startsWith('addTag')).map((c) => Number(c.split(':')[1]));

export const SEM_FRANQUIA: NaFranquia = { conhecido: false, consultaFutura: false, emAndamento: false, finalizado: false, temHistorico: false };
export const TODAS = ['▶ Retomada', '▶ Retomada 2', '▶ Retomada 3', '▶ Reativação', '▶ Reativação 2', '▶ Reativação 3', '▶ Aniversário', '▶ Aniversário tratamento', 'NO_FOLLOW_UP'];
export const franquiaFalsa = { por: (_leadId: number): NaFranquia => SEM_FRANQUIA };
export const fichas = new Map<number, { birthdate: string | null; status: string | null; emTratamento?: boolean }>();

let seq = 0;
export function ctx(extra: { intents?: Record<string, number>; tags?: string[]; agora?: number; porVarredura?: number } = {}): Ctx {
  const unit = { id: `u-rotina-${++seq}`, slug: `rotina-${seq}`, spineEnabled: false, spineToken: null, spineTimezone: 'America/Sao_Paulo', kommoSubdomain: 'teste', pipelineIntents: extra.intents ?? null } as unknown as Unit;
  const base = configBase(unit.pipelineIntents, {});
  return {
    unit,
    kommo: kommoDoCtx,
    funis,
    grupo: null,
    agora: extra.agora ?? AGORA,
    tz: 'America/Sao_Paulo',
    base,
    pausarIaFieldId: 777,
    tagsDaConta: extra.tags ?? TODAS,
    restanteNaVarredura: extra.porVarredura ?? base.porVarredura,
    franquia: async (_u, leadId) => franquiaFalsa.por(leadId),
    ficha: (async (_u: unknown, idClient: number) => {
      const f = fichas.get(idClient);
      return f
        ? { ok: true, data: { ficha: { idClient, name: 'X', gender: null, birthdate: f.birthdate, addressCity: null, addressUf: null, address: null, email: null, source: null, status: f.status, schedules: [], treatments: f.emTratamento ? [{ idStatus: TRATAMENTO_EM_ANDAMENTO }] : [] } } }
        : { ok: false, error: 'sem ficha' };
    }) as Ctx['ficha'],
  };
}

/** Zera tudo entre os testes. */
export function zerar(): void {
  tracos.clear();
  conversas.clear();
  pausados.clear();
  simulacoes.length = 0;
  cartoes.length = 0;
  chamadas.length = 0;
  tagsNoKommo.clear();
  fichas.clear();
  extrasDoKommo.outrosDoContato = [];
  extrasDoKommo.modelos = [];
  franquiaFalsa.por = () => SEM_FRANQUIA;
  _limparCacheDaRotina();
}
