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
  updatesLeadTitle?: boolean;
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
      updatesLeadTitle: input.updatesLeadTitle ?? false,
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
      ...(input.updatesLeadTitle !== undefined && {
        updatesLeadTitle: input.updatesLeadTitle,
      }),
    },
  });
}

export async function deleteLeadFieldRule(id: string): Promise<void> {
  await prisma.leadFieldRule.delete({ where: { id } });
}

export interface CaptureCoverageRow {
  ruleId: string;
  toolName: string;
  kommoFieldId: number;
  kommoFieldName: string;
  enabled: boolean;
  writes: number;
  leads: number;
  lastAt: string | null;
}

export interface CaptureCoverage {
  days: number;
  totalLeads: number;
  rows: CaptureCoverageRow[];
}

export async function getCaptureCoverage(
  unitId: string,
  days: number,
): Promise<CaptureCoverage> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rules = await listLeadFieldRules(unitId);

  const totalLeadsRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(DISTINCT lead_id) AS n
    FROM execution_traces
    WHERE unit_id = ${unitId} AND created_at >= ${since}
  `;
  const totalLeads = Number(totalLeadsRows[0]?.n ?? 0);

  const stats = await prisma.$queryRaw<
    Array<{ field_id: number; writes: bigint; leads: bigint; last_at: Date }>
  >`
    SELECT
      (s.payload->>'fieldId')::int AS field_id,
      COUNT(*)                     AS writes,
      COUNT(DISTINCT t.lead_id)    AS leads,
      MAX(s.created_at)            AS last_at
    FROM execution_steps s
    JOIN execution_traces t ON t.id = s.trace_id
    WHERE t.unit_id = ${unitId}
      AND s.created_at >= ${since}
      AND s.kind = 'KOMMO_ACTION'
      AND s.payload ? 'fieldId'
    GROUP BY 1
  `;

  const byField = new Map(stats.map((r) => [Number(r.field_id), r]));

  return {
    days,
    totalLeads,
    rows: rules.map((rule) => {
      const hit = byField.get(rule.kommoFieldId);
      return {
        ruleId: rule.id,
        toolName: rule.toolName,
        kommoFieldId: rule.kommoFieldId,
        kommoFieldName: rule.kommoFieldName,
        enabled: rule.enabled,
        writes: hit ? Number(hit.writes) : 0,
        leads: hit ? Number(hit.leads) : 0,
        lastAt: hit?.last_at ? new Date(hit.last_at).toISOString() : null,
      };
    }),
  };
}
