// ============================================================================
// templates.service.ts — CRUD de MessageTemplate.
// ============================================================================

import type { MessageTemplate } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export interface TemplateInput {
  name: string;
  triggerKeywords: string[];
  response: string;
}

export async function listTemplates(unitId: string): Promise<MessageTemplate[]> {
  return prisma.messageTemplate.findMany({
    where: { unitId },
    orderBy: { name: 'asc' },
  });
}

export async function createTemplate(unitId: string, input: TemplateInput): Promise<MessageTemplate> {
  return prisma.messageTemplate.create({
    data: {
      unitId,
      name: input.name,
      triggerKeywords: input.triggerKeywords,
      response: input.response,
    },
  });
}

export async function updateTemplate(
  unitId: string,
  id: string,
  input: Partial<TemplateInput>,
): Promise<MessageTemplate> {
  return prisma.messageTemplate.update({
    where: { id, unitId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.triggerKeywords !== undefined && { triggerKeywords: input.triggerKeywords }),
      ...(input.response !== undefined && { response: input.response }),
    },
  });
}

export async function deleteTemplate(unitId: string, id: string): Promise<void> {
  await prisma.messageTemplate.delete({ where: { id, unitId } });
}
