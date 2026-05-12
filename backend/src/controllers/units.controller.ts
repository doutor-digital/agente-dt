// ============================================================================
// units.controller.ts — CRUD de Units + KPIs.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Endpoints simples consumidos pelo painel "Unidades". Sem auth no MVP —
// roadmap.
//
// Os secrets (tokens) são MASCARADOS na resposta GET. PUT/POST aceitam
// secrets em texto puro, mas se o front mandar o valor mascarado (ex: o
// próprio campo retornado por GET), tratamos como "manter o atual" — assim
// o usuário pode editar o nome sem precisar redigitar a chave.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  createUnit,
  deleteUnit,
  listUnits,
  maskUnitSecrets,
  updateUnit,
  type UnitInput,
} from '../services/units.service.js';

// ---------------------------------------------------------------------------
// Validação.
// ---------------------------------------------------------------------------

const slugRegex = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

const unitInputBase = {
  slug: z.string().regex(slugRegex, 'slug deve ser kebab-case (a-z, 0-9, -)'),
  name: z.string().min(1).max(120),
  isActive: z.boolean().optional(),
  kommoSubdomain: z.string().nullable().optional(),
  kommoAccessToken: z.string().nullable().optional(),
  kommoSalesbotId: z.coerce.number().int().nullable().optional(),
  kommoReplyFieldId: z.coerce.number().int().nullable().optional(),
  openaiApiKey: z.string().nullable().optional(),
  openaiModel: z.string().min(1).optional(),
  openaiAssistantId: z.string().nullable().optional(),
  openaiTemperature: z.number().min(0).max(2).optional(),
  openaiMaxTokens: z.number().int().min(1).max(8192).optional(),
  metaPhoneNumberId: z.string().nullable().optional(),
  metaAccessToken: z.string().nullable().optional(),
  metaVerifyToken: z.string().nullable().optional(),
  metaAppSecret: z.string().nullable().optional(),
  systemPrompt: z.string().max(20_000).optional(),
};

const createSchema = z.object(unitInputBase);
const updateSchema = z.object({
  ...unitInputBase,
  slug: unitInputBase.slug.optional(),
  name: unitInputBase.name.optional(),
}).partial();

// Heurística pra detectar valor mascarado vindo do front e ignorá-lo no PATCH.
function isMasked(v: unknown): boolean {
  return typeof v === 'string' && v.includes('••••');
}

function dropMaskedSecrets<T extends Partial<UnitInput>>(input: T): T {
  const out: Record<string, unknown> = { ...input };
  for (const k of [
    'kommoAccessToken',
    'openaiApiKey',
    'metaAccessToken',
    'metaAppSecret',
    'metaVerifyToken',
  ] as const) {
    if (isMasked(out[k])) delete out[k];
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

export async function listUnitsHandler(_req: Request, res: Response): Promise<void> {
  const units = await listUnits();
  res.json({ units: units.map(maskUnitSecrets) });
}

export async function getUnitHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  res.json({ unit: maskUnitSecrets(unit) });
}

export async function createUnitHandler(req: Request, res: Response): Promise<void> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  try {
    const unit = await createUnit(parsed.data);
    logger.info({ id: unit.id, slug: unit.slug }, 'unit criada');
    res.status(201).json({ unit: maskUnitSecrets(unit) });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'slug_already_exists' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'falha criando unit');
    res.status(500).json({ error: 'create_failed', message: msg });
  }
}

export async function updateUnitHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  try {
    const cleaned = dropMaskedSecrets(parsed.data);
    const unit = await updateUnit(id, cleaned);
    logger.info({ id: unit.id }, 'unit atualizada');
    res.json({ unit: maskUnitSecrets(unit) });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'slug_already_exists' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'falha atualizando unit');
    res.status(500).json({ error: 'update_failed', message: msg });
  }
}

export async function deleteUnitHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  try {
    await deleteUnit(id);
    res.status(204).end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'falha deletando unit');
    res.status(500).json({ error: 'delete_failed', message: msg });
  }
}

// ---------------------------------------------------------------------------
// Stats da unidade — usados no card de header do dashboard.
// Retorna totais de execuções, taxa de sucesso, latência média, custo total
// (USD) e tokens consumidos.
// ---------------------------------------------------------------------------

export async function unitStatsHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const sinceDays = Math.min(Number(req.query.days ?? 30), 365);
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const [traces, success, failed, running, traceLatency, llmAgg, llmByModel] = await Promise.all([
    prisma.executionTrace.count({ where: { unitId: id, createdAt: { gte: since } } }),
    prisma.executionTrace.count({ where: { unitId: id, status: 'SUCCESS', createdAt: { gte: since } } }),
    prisma.executionTrace.count({ where: { unitId: id, status: 'FAILED', createdAt: { gte: since } } }),
    prisma.executionTrace.count({ where: { unitId: id, status: 'RUNNING', createdAt: { gte: since } } }),
    prisma.executionTrace.aggregate({
      where: { unitId: id, status: 'SUCCESS', createdAt: { gte: since }, latencyMs: { not: null } },
      _avg: { latencyMs: true },
    }),
    prisma.llmCall.aggregate({
      where: { unitId: id, createdAt: { gte: since } },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true, costUsd: true, latencyMs: true },
      _count: { _all: true },
    }),
    prisma.llmCall.groupBy({
      where: { unitId: id, createdAt: { gte: since } },
      by: ['model'],
      _count: { _all: true },
      _sum: { totalTokens: true, costUsd: true },
    }),
  ]);

  res.json({
    sinceDays,
    traces: {
      total: traces,
      success,
      failed,
      running,
      successRate: traces > 0 ? success / traces : 0,
      avgLatencyMs: traceLatency._avg.latencyMs ? Math.round(traceLatency._avg.latencyMs) : 0,
    },
    llm: {
      calls: llmAgg._count._all,
      promptTokens: llmAgg._sum.promptTokens ?? 0,
      completionTokens: llmAgg._sum.completionTokens ?? 0,
      totalTokens: llmAgg._sum.totalTokens ?? 0,
      costUsd: Number(llmAgg._sum.costUsd ?? 0),
      avgLatencyMs:
        llmAgg._count._all > 0 && llmAgg._sum.latencyMs
          ? Math.round(llmAgg._sum.latencyMs / llmAgg._count._all)
          : 0,
      byModel: llmByModel.map((m) => ({
        model: m.model,
        calls: m._count._all,
        totalTokens: m._sum.totalTokens ?? 0,
        costUsd: Number(m._sum.costUsd ?? 0),
      })),
    },
  });
}
