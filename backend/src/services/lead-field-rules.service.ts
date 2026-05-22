// ============================================================================
// lead-field-rules.service.ts — CRUD das regras de captura de dados.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cada LeadFieldRule é uma "tool dinâmica": o agente recebe N tools (uma por
// regra ativada) que sabem como escrever em um custom field específico do
// Kommo. O service aqui só persiste; o factory de tools é em agent/tools.ts
// e a renderização no prompt é em agent/prompt-composer.ts.
// ============================================================================

import type { LeadFieldRule } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { KommoFieldType } from './kommo.service.js';

export interface LeadFieldRuleInput {
  kommoFieldId: number;
  kommoFieldName: string;
  kommoFieldType: KommoFieldType;
  kommoFieldEnums?: Array<{ id: number; value: string }> | null;
  toolName: string;
  instruction: string;
  valueHint?: string | null;
  examples?: string[];
  enabled?: boolean;
}

export async function listLeadFieldRules(unitId: string): Promise<LeadFieldRule[]> {
  return prisma.leadFieldRule.findMany({
    where: { unitId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function listEnabledLeadFieldRules(unitId: string): Promise<LeadFieldRule[]> {
  return prisma.leadFieldRule.findMany({
    where: { unitId, enabled: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createLeadFieldRule(
  unitId: string,
  input: LeadFieldRuleInput,
): Promise<LeadFieldRule> {
  return prisma.leadFieldRule.create({
    data: {
      unitId,
      kommoFieldId: input.kommoFieldId,
      kommoFieldName: input.kommoFieldName,
      kommoFieldType: input.kommoFieldType,
      kommoFieldEnums:
        input.kommoFieldEnums && input.kommoFieldEnums.length > 0
          ? (input.kommoFieldEnums as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      toolName: input.toolName,
      instruction: input.instruction,
      valueHint: input.valueHint ?? null,
      examples: input.examples ?? [],
      enabled: input.enabled ?? true,
    },
  });
}

export async function updateLeadFieldRule(
  id: string,
  input: Partial<LeadFieldRuleInput>,
): Promise<LeadFieldRule> {
  return prisma.leadFieldRule.update({
    where: { id },
    data: {
      ...(input.kommoFieldId !== undefined && { kommoFieldId: input.kommoFieldId }),
      ...(input.kommoFieldName !== undefined && { kommoFieldName: input.kommoFieldName }),
      ...(input.kommoFieldType !== undefined && { kommoFieldType: input.kommoFieldType }),
      ...(input.kommoFieldEnums !== undefined && {
        kommoFieldEnums:
          input.kommoFieldEnums && input.kommoFieldEnums.length > 0
            ? (input.kommoFieldEnums as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
      }),
      ...(input.toolName !== undefined && { toolName: input.toolName }),
      ...(input.instruction !== undefined && { instruction: input.instruction }),
      ...(input.valueHint !== undefined && { valueHint: input.valueHint }),
      ...(input.examples !== undefined && { examples: input.examples }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });
}

export async function deleteLeadFieldRule(id: string): Promise<void> {
  await prisma.leadFieldRule.delete({ where: { id } });
}
