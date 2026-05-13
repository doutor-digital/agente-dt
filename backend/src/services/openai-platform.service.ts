// ============================================================================
// openai-platform.service.ts — Acesso aos endpoints administrativos da OpenAI.
//
// LÓGICA DE ENGENHARIA
// --------------------
// A OpenAI tem dois "níveis" de chave:
//
//   1. PROJECT KEY (sk-proj-...) — usada pra fazer inferência: chat
//      completions, embeddings, audio, etc. É o que vive em `Unit.openaiApiKey`.
//      Permissões são limitadas ao projeto onde foi criada.
//
//   2. ADMIN KEY (sk-admin-...) — chave de organização. Necessária pra
//      `/v1/organization/costs`, `/v1/organization/usage/*` e
//      `/v1/organization/projects`. Vive em `Unit.openaiAdminKey`.
//      Sem ela, só conseguimos consultar `/v1/models` (qualquer key).
//
// ENDPOINTS USADOS
// ----------------
//   GET  /v1/models                                  — ping (qualquer key)
//   GET  /v1/organization/costs?start_time=...       — gastos $USD (Admin)
//   GET  /v1/organization/usage/completions?...      — uso por modelo (Admin)
//   GET  /v1/organization/projects                   — lista projetos (Admin)
//
// PARÂMETROS DAS APIs DE COSTS/USAGE
// ----------------------------------
// `start_time` e `end_time` são timestamps Unix em segundos. `bucket_width`
// agrupa em '1d' (default), '1h' ou '1m'. As Costs API só aceita `1d`.
// `group_by` aceita ['model', 'project_id', 'line_item', 'service_tier'].
//
// NUNCA quebra o caller — toda função retorna um envelope com `{ ok, data, error }`
// pra que o handler do painel mostre o estado do componente sem tirar tudo do ar.
// ============================================================================

import axios, { type AxiosInstance } from 'axios';
import { logger } from '../lib/logger.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';

interface CallEnvelope<T> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: string;
}

function buildClient(apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: OPENAI_API_BASE,
    timeout: 12_000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    // Retornamos o erro como envelope, então não quebramos no .data
    validateStatus: () => true,
  });
}

function envelopeFromAxios<T>(status: number, data: unknown): CallEnvelope<T> {
  if (status >= 200 && status < 300) {
    return { ok: true, status, data: data as T };
  }
  // OpenAI manda { error: { message, code, type } }
  const errMsg = (() => {
    const d = data as { error?: { message?: string; code?: string } } | string;
    if (typeof d === 'string') return d;
    return d?.error?.message ?? 'erro desconhecido';
  })();
  return { ok: false, status, error: errMsg };
}

// ---------------------------------------------------------------------------
// Ping — qualquer key (project ou admin) consegue listar /v1/models.
// Retorna a contagem + alguns nomes pra UI confirmar conectividade.
// ---------------------------------------------------------------------------

export interface PingResult {
  reachable: boolean;
  modelCount: number;
  sampleModels: string[];
  status?: number;
  error?: string;
}

export async function pingOpenAI(apiKey: string | null): Promise<PingResult> {
  if (!apiKey) {
    return { reachable: false, modelCount: 0, sampleModels: [], error: 'sem api key' };
  }
  try {
    const http = buildClient(apiKey);
    const res = await http.get('/models');
    const env = envelopeFromAxios<{ data: Array<{ id: string }> }>(res.status, res.data);
    if (!env.ok) {
      return { reachable: false, modelCount: 0, sampleModels: [], status: env.status, error: env.error };
    }
    const models = env.data?.data ?? [];
    return {
      reachable: true,
      modelCount: models.length,
      sampleModels: models.slice(0, 6).map((m) => m.id),
      status: env.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'pingOpenAI falhou');
    return { reachable: false, modelCount: 0, sampleModels: [], error: msg };
  }
}

// ---------------------------------------------------------------------------
// Costs API — gastos diários em USD da organização.
// /v1/organization/costs aceita start_time, end_time, bucket_width=1d, group_by.
// Retorna `{ data: [{ start_time, end_time, results: [{ amount: { value, currency }, ... }] }] }`
// ---------------------------------------------------------------------------

export interface CostBucket {
  startTime: number;
  endTime: number;
  amountUsd: number;
  byProject?: Array<{ projectId: string | null; amountUsd: number }>;
}

export interface CostsResult {
  ok: boolean;
  totalUsd: number;
  buckets: CostBucket[];
  error?: string;
  status?: number;
}

export async function getCosts(adminKey: string | null, sinceDays: number): Promise<CostsResult> {
  if (!adminKey) {
    return { ok: false, totalUsd: 0, buckets: [], error: 'sem admin key' };
  }
  const startTime = Math.floor((Date.now() - sinceDays * 86_400_000) / 1000);
  try {
    const http = buildClient(adminKey);
    const res = await http.get('/organization/costs', {
      params: {
        start_time: startTime,
        bucket_width: '1d',
        group_by: 'project_id',
        limit: 180,
      },
    });
    const env = envelopeFromAxios<{
      data: Array<{
        start_time: number;
        end_time: number;
        results: Array<{
          amount: { value: number; currency: string };
          project_id?: string | null;
        }>;
      }>;
    }>(res.status, res.data);

    if (!env.ok) {
      return { ok: false, totalUsd: 0, buckets: [], error: env.error, status: env.status };
    }

    const buckets: CostBucket[] = (env.data?.data ?? []).map((b) => {
      const byProject = b.results.map((r) => ({
        projectId: r.project_id ?? null,
        amountUsd: r.amount?.value ?? 0,
      }));
      const amountUsd = byProject.reduce((s, p) => s + p.amountUsd, 0);
      return {
        startTime: b.start_time,
        endTime: b.end_time,
        amountUsd,
        byProject,
      };
    });
    const totalUsd = buckets.reduce((s, b) => s + b.amountUsd, 0);
    return { ok: true, totalUsd, buckets };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'getCosts falhou');
    return { ok: false, totalUsd: 0, buckets: [], error: msg };
  }
}

// ---------------------------------------------------------------------------
// Usage API (completions) — tokens consumidos por dia/modelo.
// /v1/organization/usage/completions aceita start_time, bucket_width, group_by.
// ---------------------------------------------------------------------------

export interface UsageByModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  numRequests: number;
}

export interface UsageResult {
  ok: boolean;
  buckets: Array<{
    startTime: number;
    endTime: number;
    inputTokens: number;
    outputTokens: number;
    numRequests: number;
  }>;
  byModel: UsageByModel[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    numRequests: number;
  };
  error?: string;
  status?: number;
}

export async function getUsageCompletions(
  adminKey: string | null,
  sinceDays: number,
): Promise<UsageResult> {
  if (!adminKey) {
    return {
      ok: false,
      buckets: [],
      byModel: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, numRequests: 0 },
      error: 'sem admin key',
    };
  }
  const startTime = Math.floor((Date.now() - sinceDays * 86_400_000) / 1000);
  try {
    const http = buildClient(adminKey);
    const res = await http.get('/organization/usage/completions', {
      params: {
        start_time: startTime,
        bucket_width: '1d',
        group_by: 'model',
        limit: 180,
      },
    });
    const env = envelopeFromAxios<{
      data: Array<{
        start_time: number;
        end_time: number;
        results: Array<{
          input_tokens: number;
          output_tokens: number;
          num_model_requests: number;
          model?: string;
        }>;
      }>;
    }>(res.status, res.data);
    if (!env.ok) {
      return {
        ok: false,
        buckets: [],
        byModel: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, numRequests: 0 },
        error: env.error,
        status: env.status,
      };
    }

    const buckets = (env.data?.data ?? []).map((b) => {
      const inputTokens = b.results.reduce((s, r) => s + (r.input_tokens || 0), 0);
      const outputTokens = b.results.reduce((s, r) => s + (r.output_tokens || 0), 0);
      const numRequests = b.results.reduce((s, r) => s + (r.num_model_requests || 0), 0);
      return { startTime: b.start_time, endTime: b.end_time, inputTokens, outputTokens, numRequests };
    });

    const byModelMap = new Map<string, UsageByModel>();
    for (const bucket of env.data?.data ?? []) {
      for (const r of bucket.results) {
        const key = r.model ?? 'unknown';
        const cur = byModelMap.get(key) ?? {
          model: key,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          numRequests: 0,
        };
        cur.inputTokens += r.input_tokens || 0;
        cur.outputTokens += r.output_tokens || 0;
        cur.totalTokens = cur.inputTokens + cur.outputTokens;
        cur.numRequests += r.num_model_requests || 0;
        byModelMap.set(key, cur);
      }
    }

    const totals = buckets.reduce(
      (acc, b) => ({
        inputTokens: acc.inputTokens + b.inputTokens,
        outputTokens: acc.outputTokens + b.outputTokens,
        totalTokens: acc.inputTokens + acc.outputTokens + b.inputTokens + b.outputTokens,
        numRequests: acc.numRequests + b.numRequests,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, numRequests: 0 },
    );
    totals.totalTokens = totals.inputTokens + totals.outputTokens;

    return {
      ok: true,
      buckets,
      byModel: [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens),
      totals,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'getUsageCompletions falhou');
    return {
      ok: false,
      buckets: [],
      byModel: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, numRequests: 0 },
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Lista projetos da organização (Admin only).
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  id: string;
  name: string;
  status: string;
  createdAt: number;
}

export async function listProjects(
  adminKey: string | null,
): Promise<{ ok: boolean; projects: ProjectInfo[]; error?: string }> {
  if (!adminKey) {
    return { ok: false, projects: [], error: 'sem admin key' };
  }
  try {
    const http = buildClient(adminKey);
    const res = await http.get('/organization/projects');
    const env = envelopeFromAxios<{
      data: Array<{ id: string; name: string; status: string; created_at: number }>;
    }>(res.status, res.data);
    if (!env.ok) return { ok: false, projects: [], error: env.error };
    const projects = (env.data?.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      createdAt: p.created_at,
    }));
    return { ok: true, projects };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, projects: [], error: msg };
  }
}

// ---------------------------------------------------------------------------
// Cache curto em memória — Costs/Usage da OpenAI tem rate-limit baixo
// (algumas chamadas/min). Cacheamos por 60s por (adminKey, sinceDays).
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}
const cache = new Map<string, CacheEntry<unknown>>();
const TTL_MS = 60_000;

async function cached<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await factory();
  cache.set(key, { expiresAt: Date.now() + TTL_MS, value });
  return value;
}

export const OpenAIPlatform = {
  pingOpenAI,
  getCosts: (adminKey: string | null, sinceDays: number) =>
    cached(`costs:${adminKey ?? 'none'}:${sinceDays}`, () => getCosts(adminKey, sinceDays)),
  getUsageCompletions: (adminKey: string | null, sinceDays: number) =>
    cached(`usage:${adminKey ?? 'none'}:${sinceDays}`, () =>
      getUsageCompletions(adminKey, sinceDays),
    ),
  listProjects: (adminKey: string | null) =>
    cached(`projects:${adminKey ?? 'none'}`, () => listProjects(adminKey)),
};
