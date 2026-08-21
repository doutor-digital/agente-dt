import { prisma } from '../lib/prisma.js';

export interface ChangeLogInput {
  category?: string;
  summary: string;
  details?: string | null;
  author?: string | null;
}

export function listChangeLog(unitId: string) {
  return prisma.unitChangeLog.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

export function addChangeLog(unitId: string, input: ChangeLogInput) {
  return prisma.unitChangeLog.create({
    data: {
      unitId,
      category: input.category ?? 'treino',
      summary: input.summary,
      details: input.details ?? null,
      author: input.author ?? 'IA',
    },
  });
}
