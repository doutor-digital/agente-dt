// ============================================================================
// traces.controller.ts — API REST consumida pelo dashboard React.
//
// LÓGICA DE ENGENHARIA — MULTI-TENANT
// -----------------------------------
// O `unitId` que será aplicado vem em duas fontes, com prioridade:
//   1. Se o user é UNIT_ADMIN → SEMPRE força `req.user.unitId`
//      (ignora query param — não confia no cliente).
//   2. Se o user é SUPER_ADMIN → respeita o query param (`?unitId=...`).
//      Sem o query, vê tudo (visão admin global).
//
// Endpoints:
//   GET /api/traces?unitId=...&limit=...
//   GET /api/traces/:id
//   GET /api/stats?unitId=...
// ============================================================================

import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

// Resolve o unitId efetivo respeitando role do user.
// Retorna `undefined` se super admin pediu visão global (sem filtro).
function resolveUnitFilter(req: Request): string | undefined {
  if (req.user?.role === 'UNIT_ADMIN') {
    return req.user.unitId ?? '__never_match__'; // unit_admin sem unit = vê nada
  }
  return (req.query.unitId as string | undefined) ?? undefined;
}

export async function listTraces(req: Request, res: Response): Promise<void> {
  const take = Math.min(Number(req.query.limit ?? 50), 200);
  const unitId = resolveUnitFilter(req);

  const traces = await prisma.executionTrace.findMany({
    where: unitId ? { unitId } : undefined,
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      threadId: true,
      leadId: true,
      unitId: true,
      channel: true,
      status: true,
      latencyMs: true,
      createdAt: true,
      iaDecision: true,
    },
  });
  res.json({ traces });
}

export async function getTrace(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const trace = await prisma.executionTrace.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { sequence: 'asc' } },
      llmCalls: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          model: true,
          endpoint: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          costUsd: true,
          latencyMs: true,
          status: true,
          createdAt: true,
        },
      },
      unit: { select: { id: true, slug: true, name: true } },
    },
  });
  if (!trace) {
    res.status(404).json({ error: 'trace not found' });
    return;
  }
  // UNIT_ADMIN só vê traces da própria unit.
  if (req.user?.role === 'UNIT_ADMIN' && trace.unitId !== req.user.unitId) {
    res.status(404).json({ error: 'trace not found' });
    return;
  }
  res.json({
    trace: {
      ...trace,
      llmCalls: trace.llmCalls.map((c) => ({ ...c, costUsd: Number(c.costUsd) })),
    },
  });
}

export async function getStats(req: Request, res: Response): Promise<void> {
  const unitId = resolveUnitFilter(req);
  const where = unitId ? { unitId } : {};

  const [total, success, failed, running, avg, llmAgg] = await Promise.all([
    prisma.executionTrace.count({ where }),
    prisma.executionTrace.count({ where: { ...where, status: 'SUCCESS' } }),
    prisma.executionTrace.count({ where: { ...where, status: 'FAILED' } }),
    prisma.executionTrace.count({ where: { ...where, status: 'RUNNING' } }),
    prisma.executionTrace.aggregate({
      where: { ...where, latencyMs: { not: null }, status: 'SUCCESS' },
      _avg: { latencyMs: true },
    }),
    prisma.llmCall.aggregate({
      where: unitId ? { unitId } : {},
      _sum: { totalTokens: true, costUsd: true },
      _count: { _all: true },
    }),
  ]);

  const successRate = total > 0 ? success / total : 0;

  res.json({
    total,
    success,
    failed,
    running,
    successRate,
    avgLatencyMs: avg._avg.latencyMs ? Math.round(avg._avg.latencyMs) : 0,
    llm: {
      calls: llmAgg._count._all,
      totalTokens: llmAgg._sum.totalTokens ?? 0,
      costUsd: Number(llmAgg._sum.costUsd ?? 0),
    },
  });
}
