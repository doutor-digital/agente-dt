// ============================================================================
// meta-analytics.service.ts — Graph API analytics da Meta WhatsApp Cloud.
//
// LÓGICA DE ENGENHARIA
// --------------------
// A Meta cobra por mensagem desde 01/07/2025 (per-message pricing). Os
// endpoints relevantes vivem na WABA (não no phone_number_id):
//
//   GET /v25.0/{WABA_ID}/pricing_analytics
//       — VOLUME + COST por dia, segmentado por PRICING_CATEGORY,
//         PRICING_TYPE, COUNTRY, PHONE, TIER.
//
//   GET /v25.0/{WABA_ID}/template_analytics
//       — SENT/DELIVERED/READ/CLICKED por template, opcionalmente COST.
//
//   GET /v25.0/{WABA_ID}/message_templates
//       — lista de templates (pra denormalizar template_name + language).
//
// CADA UNIDADE TEM AS PRÓPRIAS CREDENCIAIS — toda função recebe `unit`.
// O token usado é o mesmo `metaAccessToken` (precisa do escopo
// `whatsapp_business_management` além do já-requerido `whatsapp_business_messaging`).
//
// PADRÃO DE ENVELOPE
// ------------------
// Toda função retorna `{ ok, data?, error?, status? }` (como
// openai-platform.service.ts). Nunca lança — UI/sync param de quebrar quando
// o token expira.
// ============================================================================

import axios from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';

const META_GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Tipos públicos.
// ---------------------------------------------------------------------------

export interface CallEnvelope<T> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
}

/** Linha de pricing_analytics achatada — uma por combinação dimensional. */
export interface PricingAnalyticsRow {
  /** Início do bucket — segundos Unix. */
  start: number;
  /** Fim do bucket — segundos Unix. */
  end: number;
  pricingCategory: string;
  pricingType: string;
  country: string;
  phoneNumber: string;
  tier: string;
  volume: number;
  costUsd: number;
  currency: string;
}

export interface PricingAnalyticsResult {
  rows: PricingAnalyticsRow[];
  totalVolume: number;
  totalCostUsd: number;
}

/** Linha agregada de template_analytics por template/dia. */
export interface TemplateAnalyticsRow {
  start: number;
  end: number;
  templateId: string;
  templateName: string | null;
  language: string;
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  costUsd: number;
  currency: string;
}

export interface TemplateAnalyticsResult {
  rows: TemplateAnalyticsRow[];
}

export interface MessageTemplate {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string | null;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function describeAxiosError(err: unknown): { status?: number; message: string } {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data as { error?: { message?: string; code?: number } } | undefined;
    return {
      status,
      message: body?.error?.message ?? err.message,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

function unitHasAnalyticsCreds(unit: Pick<Unit, 'metaWabaId' | 'metaAccessToken'>): boolean {
  return !!unit.metaWabaId && !!unit.metaAccessToken;
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

// ---------------------------------------------------------------------------
// pricing_analytics.
// ---------------------------------------------------------------------------
// Response da Meta (shape observado — pode variar entre versões):
// {
//   "data": [{
//     "start": 1735689600,
//     "end":   1735776000,
//     "granularity": "DAILY",
//     "data_points": [{
//       "start": 1735689600, "end": 1735776000,
//       "country": "BR",
//       "pricing_category": "MARKETING",
//       "pricing_type": "REGULAR",
//       "tier": "TIER_1",
//       "phone_number": "...",
//       "volume": 123,
//       "cost": 4.56
//     }]
//   }],
//   "paging": { ... }
// }
//
// Em alguns casos a Meta achata e devolve `data: [{ start, end, country, ...,
// volume, cost }]` direto sem `data_points`. Aceitamos os dois shapes.
// ---------------------------------------------------------------------------

export interface FetchPricingArgs {
  /** Unix seconds — início inclusivo. */
  start: number;
  /** Unix seconds — fim exclusivo. */
  end: number;
  /** Default DAILY. */
  granularity?: 'HALF_HOUR' | 'DAILY' | 'MONTHLY';
}

interface PricingDataPoint {
  start?: number | string;
  end?: number | string;
  country?: string | null;
  pricing_category?: string | null;
  pricing_type?: string | null;
  tier?: string | null;
  phone_number?: string | null;
  volume?: number | string;
  cost?: number | string | { value?: number; currency?: string };
}

interface PricingRoot {
  data?: Array<{
    start?: number | string;
    end?: number | string;
    granularity?: string;
    data_points?: PricingDataPoint[];
    // Shape achatado:
    country?: string | null;
    pricing_category?: string | null;
    pricing_type?: string | null;
    tier?: string | null;
    phone_number?: string | null;
    volume?: number | string;
    cost?: number | string | { value?: number; currency?: string };
  }>;
}

function extractCost(raw: PricingDataPoint['cost']): { amount: number; currency: string } {
  if (raw === null || raw === undefined) return { amount: 0, currency: 'USD' };
  if (typeof raw === 'number' || typeof raw === 'string') {
    return { amount: toNum(raw), currency: 'USD' };
  }
  return { amount: toNum(raw.value), currency: raw.currency ?? 'USD' };
}

function normalizePricingPoint(
  parentStart: number,
  parentEnd: number,
  pt: PricingDataPoint,
): PricingAnalyticsRow {
  const { amount, currency } = extractCost(pt.cost);
  return {
    start: toNum(pt.start ?? parentStart),
    end: toNum(pt.end ?? parentEnd),
    pricingCategory: toStr(pt.pricing_category ?? 'UNKNOWN'),
    pricingType: toStr(pt.pricing_type ?? 'REGULAR'),
    country: toStr(pt.country),
    phoneNumber: toStr(pt.phone_number),
    tier: toStr(pt.tier),
    volume: toNum(pt.volume),
    costUsd: amount,
    currency,
  };
}

export async function fetchPricingAnalytics(
  unit: Pick<Unit, 'metaWabaId' | 'metaAccessToken'>,
  args: FetchPricingArgs,
): Promise<CallEnvelope<PricingAnalyticsResult>> {
  if (!unitHasAnalyticsCreds(unit)) {
    return { ok: false, error: 'sem metaWabaId ou metaAccessToken' };
  }
  const granularity = args.granularity ?? 'DAILY';
  // A Graph API exige arrays como JSON-encoded string nos query params.
  const params = {
    start: args.start,
    end: args.end,
    granularity,
    metric_types: JSON.stringify(['VOLUME', 'COST']),
    dimensions: JSON.stringify(['PRICING_CATEGORY', 'PRICING_TYPE', 'COUNTRY', 'PHONE', 'TIER']),
    access_token: unit.metaAccessToken,
  };
  try {
    const url = `${META_GRAPH_BASE}/${unit.metaWabaId}/pricing_analytics`;
    const res = await axios.get<PricingRoot>(url, {
      params,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      const errMsg = (res.data as unknown as { error?: { message?: string } })?.error?.message
        ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: errMsg };
    }

    const rows: PricingAnalyticsRow[] = [];
    for (const bucket of res.data?.data ?? []) {
      const parentStart = toNum(bucket.start);
      const parentEnd = toNum(bucket.end);
      // Caso 1: vem com `data_points` (granularity DAILY normal).
      if (Array.isArray(bucket.data_points) && bucket.data_points.length > 0) {
        for (const pt of bucket.data_points) {
          rows.push(normalizePricingPoint(parentStart, parentEnd, pt));
        }
        continue;
      }
      // Caso 2: vem achatado direto no nó.
      if (
        bucket.pricing_category !== undefined
        || bucket.volume !== undefined
        || bucket.cost !== undefined
      ) {
        rows.push(normalizePricingPoint(parentStart, parentEnd, bucket as PricingDataPoint));
      }
    }

    const totalVolume = rows.reduce((s, r) => s + r.volume, 0);
    const totalCostUsd = rows.reduce((s, r) => s + r.costUsd, 0);

    return { ok: true, status: res.status, data: { rows, totalVolume, totalCostUsd } };
  } catch (err) {
    const { status, message } = describeAxiosError(err);
    logger.warn({ err, unitWaba: unit.metaWabaId }, 'fetchPricingAnalytics falhou');
    return { ok: false, status, error: message };
  }
}

// ---------------------------------------------------------------------------
// template_analytics.
// ---------------------------------------------------------------------------
// Response shape (similar a pricing_analytics):
// {
//   "data": [{
//     "start": ..., "end": ...,
//     "granularity": "DAILY",
//     "data_points": [{
//       "template_id": "1234567890",
//       "sent": 100, "delivered": 95, "read": 60, "clicked": 12,
//       "cost": 3.14
//     }]
//   }]
// }
//
// Em alguns retornos a Meta vem por template-id na raíz: { template_id, sent,
// delivered, ...}. Tratamos os dois.
// ---------------------------------------------------------------------------

interface TemplateDataPoint {
  start?: number | string;
  end?: number | string;
  template_id?: string | number | null;
  sent?: number | string;
  delivered?: number | string;
  read?: number | string;
  clicked?: number | string;
  cost?: number | string | { value?: number; currency?: string };
}

interface TemplateRoot {
  data?: Array<{
    start?: number | string;
    end?: number | string;
    granularity?: string;
    data_points?: TemplateDataPoint[];
    // Shape achatado:
    template_id?: string | number | null;
    sent?: number | string;
    delivered?: number | string;
    read?: number | string;
    clicked?: number | string;
    cost?: number | string | { value?: number; currency?: string };
  }>;
}

export interface FetchTemplateAnalyticsArgs {
  start: number;
  end: number;
  granularity?: 'DAILY';
  /** Lista de template_ids — alguns retornos exigem. Se vazio, omitimos. */
  templateIds?: string[];
}

function normalizeTemplatePoint(
  parentStart: number,
  parentEnd: number,
  pt: TemplateDataPoint,
  templateMeta: Map<string, MessageTemplate>,
): TemplateAnalyticsRow {
  const templateId = toStr(pt.template_id);
  const { amount, currency } = extractCost(pt.cost);
  const meta = templateMeta.get(templateId);
  return {
    start: toNum(pt.start ?? parentStart),
    end: toNum(pt.end ?? parentEnd),
    templateId,
    templateName: meta?.name ?? null,
    language: meta?.language ?? '',
    sent: toNum(pt.sent),
    delivered: toNum(pt.delivered),
    read: toNum(pt.read),
    clicked: toNum(pt.clicked),
    costUsd: amount,
    currency,
  };
}

export async function fetchTemplateAnalytics(
  unit: Pick<Unit, 'metaWabaId' | 'metaAccessToken'>,
  args: FetchTemplateAnalyticsArgs,
  templateMeta: Map<string, MessageTemplate> = new Map(),
): Promise<CallEnvelope<TemplateAnalyticsResult>> {
  if (!unitHasAnalyticsCreds(unit)) {
    return { ok: false, error: 'sem metaWabaId ou metaAccessToken' };
  }
  const granularity = args.granularity ?? 'DAILY';
  // metric_types varia por versão; SENT/DELIVERED/READ/CLICKED são estáveis.
  // COST está disponível pra alguns templates — pedimos sempre, Meta ignora se N/A.
  const params: Record<string, unknown> = {
    start: args.start,
    end: args.end,
    granularity,
    metric_types: JSON.stringify(['SENT', 'DELIVERED', 'READ', 'CLICKED', 'COST']),
    access_token: unit.metaAccessToken,
  };
  if (args.templateIds && args.templateIds.length > 0) {
    params.template_ids = JSON.stringify(args.templateIds);
  }
  try {
    const url = `${META_GRAPH_BASE}/${unit.metaWabaId}/template_analytics`;
    const res = await axios.get<TemplateRoot>(url, {
      params,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      const errMsg = (res.data as unknown as { error?: { message?: string } })?.error?.message
        ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: errMsg };
    }

    const rows: TemplateAnalyticsRow[] = [];
    for (const bucket of res.data?.data ?? []) {
      const parentStart = toNum(bucket.start);
      const parentEnd = toNum(bucket.end);
      if (Array.isArray(bucket.data_points) && bucket.data_points.length > 0) {
        for (const pt of bucket.data_points) {
          rows.push(normalizeTemplatePoint(parentStart, parentEnd, pt, templateMeta));
        }
        continue;
      }
      if (
        bucket.template_id !== undefined
        || bucket.sent !== undefined
        || bucket.delivered !== undefined
      ) {
        rows.push(normalizeTemplatePoint(parentStart, parentEnd, bucket as TemplateDataPoint, templateMeta));
      }
    }

    return { ok: true, status: res.status, data: { rows } };
  } catch (err) {
    const { status, message } = describeAxiosError(err);
    logger.warn({ err, unitWaba: unit.metaWabaId }, 'fetchTemplateAnalytics falhou');
    return { ok: false, status, error: message };
  }
}

// ---------------------------------------------------------------------------
// message_templates (lista) — só usamos pra denormalizar name+language.
// Endpoint pagina; pegamos até 200 templates (suficiente pra UI).
// ---------------------------------------------------------------------------

interface MessageTemplateRoot {
  data?: Array<{
    id?: string;
    name?: string;
    language?: string;
    category?: string;
    status?: string;
  }>;
}

export async function fetchMessageTemplates(
  unit: Pick<Unit, 'metaWabaId' | 'metaAccessToken'>,
): Promise<CallEnvelope<MessageTemplate[]>> {
  if (!unitHasAnalyticsCreds(unit)) {
    return { ok: false, error: 'sem metaWabaId ou metaAccessToken' };
  }
  try {
    const url = `${META_GRAPH_BASE}/${unit.metaWabaId}/message_templates`;
    const res = await axios.get<MessageTemplateRoot>(url, {
      params: {
        fields: 'id,name,language,category,status',
        limit: 200,
        access_token: unit.metaAccessToken,
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      const errMsg = (res.data as unknown as { error?: { message?: string } })?.error?.message
        ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: errMsg };
    }
    const items: MessageTemplate[] = (res.data?.data ?? []).map((t) => ({
      id: toStr(t.id),
      name: toStr(t.name),
      language: toStr(t.language),
      category: t.category ?? null,
      status: t.status ?? null,
    }));
    return { ok: true, status: res.status, data: items };
  } catch (err) {
    const { status, message } = describeAxiosError(err);
    logger.warn({ err, unitWaba: unit.metaWabaId }, 'fetchMessageTemplates falhou');
    return { ok: false, status, error: message };
  }
}

// ---------------------------------------------------------------------------
// Cache curto em memória — mesma ideia do openai-platform.service.
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}
const cache = new Map<string, CacheEntry<unknown>>();
const TTL_MS = 60_000;

function cacheKey(prefix: string, parts: Array<string | number | undefined | null>): string {
  return `${prefix}:${parts.map((p) => p ?? 'null').join(':')}`;
}

async function cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await factory();
  cache.set(key, { expiresAt: Date.now() + TTL_MS, value });
  return value;
}

export const MetaAnalytics = {
  fetchPricingAnalytics: (
    unit: Pick<Unit, 'metaWabaId' | 'metaAccessToken'>,
    args: FetchPricingArgs,
  ) =>
    cached(
      cacheKey('pricing', [unit.metaWabaId, args.start, args.end, args.granularity ?? 'DAILY']),
      () => fetchPricingAnalytics(unit, args),
    ),
  fetchTemplateAnalytics: (
    unit: Pick<Unit, 'metaWabaId' | 'metaAccessToken'>,
    args: FetchTemplateAnalyticsArgs,
    meta?: Map<string, MessageTemplate>,
  ) =>
    cached(
      cacheKey('templates', [
        unit.metaWabaId,
        args.start,
        args.end,
        args.granularity ?? 'DAILY',
        (args.templateIds ?? []).sort().join(','),
      ]),
      () => fetchTemplateAnalytics(unit, args, meta),
    ),
  fetchMessageTemplates: (unit: Pick<Unit, 'metaWabaId' | 'metaAccessToken'>) =>
    cached(cacheKey('templates_meta', [unit.metaWabaId]), () => fetchMessageTemplates(unit)),
};

export function clearMetaAnalyticsCache(): number {
  const n = cache.size;
  cache.clear();
  return n;
}
