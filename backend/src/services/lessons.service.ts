import { prisma } from '../lib/prisma.js';

export interface LessonInput {
  content: string;
  source?: string;
  enabled?: boolean;
}

export function listEnabledLessons(unitId: string) {
  return prisma.unitLesson.findMany({
    where: { unitId, enabled: true },
    orderBy: { createdAt: 'asc' },
    take: 40,
  });
}

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
