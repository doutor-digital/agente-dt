// ============================================================================
// lessons.service.ts — memória procedural por unidade ("aprendizados").
//
// São regras curtas e imperativas que a IA aplica pra AQUELA clínica, além da
// persona/fontes. Entram no prompt via renderLessons (prompt-composer). CRUD é
// escopado por unitId (tenant-safe) — updateMany/deleteMany com {id, unitId}.
// ============================================================================

import { prisma } from '../lib/prisma.js';

export interface LessonInput {
  content: string;
  source?: string;
  enabled?: boolean;
}

/** Só as ativas — é o que vai pro prompt. Take limitado pra não inflar. */
export function listEnabledLessons(unitId: string) {
  return prisma.unitLesson.findMany({
    where: { unitId, enabled: true },
    orderBy: { createdAt: 'asc' },
    take: 40,
  });
}

/** Todas (pro painel), mais recente primeiro. */
export function listLessons(unitId: string) {
  return prisma.unitLesson.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

export function createLesson(unitId: string, input: LessonInput) {
  return prisma.unitLesson.create({
    data: {
      unitId,
      content: input.content.trim(),
      source: input.source ?? 'manual',
      enabled: input.enabled ?? true,
    },
  });
}

/** Escopado por unitId pra um admin não mexer em lição de outra unidade. */
export async function updateLesson(
  unitId: string,
  id: string,
  patch: Partial<LessonInput>,
): Promise<number> {
  const { count } = await prisma.unitLesson.updateMany({
    where: { id, unitId },
    data: {
      ...(patch.content !== undefined ? { content: patch.content.trim() } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    },
  });
  return count;
}

export async function deleteLesson(unitId: string, id: string): Promise<number> {
  const { count } = await prisma.unitLesson.deleteMany({ where: { id, unitId } });
  return count;
}
