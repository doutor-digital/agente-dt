// ============================================================================
// logs.controller.ts — API REST do painel "Erros" (warn/error/fatal).
//
// LÓGICA DE ENGENHARIA — MULTI-TENANT
// -----------------------------------
// Mesmo padrão do traces.controller.ts:
//  - UNIT_ADMIN: forçado à própria unit (ignora query param).
//  - SUPER_ADMIN: respeita ?unitId; sem param vê tudo.
//
// Filtros suportados:
//   level   — WARN | ERROR | FATAL
//   module  — match exato (ex: "kommo.service")
//   q       — busca case-insensitive em `msg`
//   since   — ISO date; só logs >= esse instante
//   unitId  — usado por SUPER_ADMIN
//
// Limite fixo de 200 (mesmo do listTraces). Ordenado por createdAt desc.
// ============================================================================

import type { Request, Response } from 'express';
import type { LogLevel, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

const VALID_LEVELS = new Set<LogLevel>(['WARN', 'ERROR', 'FATAL']);

function resolveUnitFilter(req: Request): string | undefined {
  if (req.user?.role === 'UNIT_ADMIN') {
    return req.user.unitId ?? '__never_match__';
  }
  return (req.query.unitId as string | undefined) ?? undefined;
}

export async function listSystemLogs(req: Request, res: Response): Promise<void> {
  const take = Math.min(Number(req.query.limit ?? 100), 200);

  const where: Prisma.SystemLogWhereInput = {};

  const unitId = resolveUnitFilter(req);
  if (unitId) where.unitId = unitId;

  const rawLevel = (req.query.level as string | undefined)?.toUpperCase();
  if (rawLevel && VALID_LEVELS.has(rawLevel as LogLevel)) {
    where.level = rawLevel as LogLevel;
  }

  const module = (req.query.module as string | undefined)?.trim();
  if (module) where.module = module;

  const q = (req.query.q as string | undefined)?.trim();
  if (q) where.msg = { contains: q, mode: 'insensitive' };

  const since = (req.query.since as string | undefined)?.trim();
  if (since) {
    const sinceDate = new Date(since);
    if (!Number.isNaN(sinceDate.getTime())) {
      where.createdAt = { gte: sinceDate };
    }
  }

  const [logs, totalByLevel] = await Promise.all([
    prisma.systemLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        level: true,
        module: true,
        msg: true,
        context: true,
        unitId: true,
        traceId: true,
        createdAt: true,
      },
    }),
    prisma.systemLog.groupBy({
      by: ['level'],
      where: unitId ? { unitId } : undefined,
      _count: { _all: true },
    }),
  ]);

  const counts = { WARN: 0, ERROR: 0, FATAL: 0 } as Record<LogLevel, number>;
  for (const row of totalByLevel) counts[row.level] = row._count._all;

  res.json({ logs, counts });
}

// Lista distinct modules — alimenta o dropdown do filtro no front.
export async function listSystemLogModules(req: Request, res: Response): Promise<void> {
  const unitId = resolveUnitFilter(req);
  const rows = await prisma.systemLog.findMany({
    where: { module: { not: null }, ...(unitId ? { unitId } : {}) },
    distinct: ['module'],
    select: { module: true },
    orderBy: { module: 'asc' },
    take: 200,
  });
  res.json({ modules: rows.map((r) => r.module).filter(Boolean) });
}
