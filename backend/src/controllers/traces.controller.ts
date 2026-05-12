// ============================================================================
// traces.controller.ts — API REST consumida pelo dashboard React.
//
// LÓGICA DE ENGENHARIA
// --------------------
// O frontend tem dois modos de visualização:
//
//  1. Sidebar (lista de webhooks): /api/traces
//     Retorna array paginado com metadados resumidos (sem steps).
//
//  2. Console de raciocínio: /api/traces/:id
//     Retorna o trace + todos os steps ordenados — o feed completo.
//
//  3. Stats agregadas (header do dashboard): /api/stats
//     Retorna totais, taxa de sucesso, latência média.
//
// Mantemos os endpoints "burros" — sem regras de negócio. Cada um é um
// SELECT direto. Em produção valeria cache (Redis) para o /stats.
// ============================================================================

import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function listTraces(req: Request, res: Response): Promise<void> {
  const take = Math.min(Number(req.query.limit ?? 50), 200);
  const traces = await prisma.executionTrace.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      threadId: true,
      leadId: true,
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
    },
  });
  if (!trace) {
    res.status(404).json({ error: 'trace not found' });
    return;
  }
  res.json({ trace });
}

export async function getStats(_req: Request, res: Response): Promise<void> {
  // Agregações em paralelo para minimizar latência total.
  const [total, success, failed, running, avg] = await Promise.all([
    prisma.executionTrace.count(),
    prisma.executionTrace.count({ where: { status: 'SUCCESS' } }),
    prisma.executionTrace.count({ where: { status: 'FAILED' } }),
    prisma.executionTrace.count({ where: { status: 'RUNNING' } }),
    prisma.executionTrace.aggregate({
      where: { latencyMs: { not: null }, status: 'SUCCESS' },
      _avg: { latencyMs: true },
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
  });
}
