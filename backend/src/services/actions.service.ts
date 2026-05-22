// ============================================================================
// actions.service.ts — CRUD de UnitAction (regras "quando → faça").
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cada UnitAction é uma regra com 1 condição em PT-BR + 1 ou MAIS ações que
// disparam juntas. O prompt-composer chama listEnabledActions() e renderiza
// como item da seção "AÇÕES CONFIGURADAS".
//
// FORMATO DE STORAGE
// ------------------
// Campo `actions` (Json) é o canônico: Array<{ kind, params }>.
// Os campos legados `actionKind` / `actionParams` permanecem só pra rollback;
// `readActions()` cai pra eles quando `actions` está vazio (regras antigas
// não migradas pelo backfill).
// ============================================================================

import type { UnitAction } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type ActionKind =
  | 'add_tag'
  | 'move_stage'
  | 'transfer_with_permission'
  | 'transfer_without_permission'
  | 'summarize_to_note';

export interface AddTagParams {
  tags: string[];
}

export interface MoveStageParams {
  statusId: number;
  pipelineId?: number;
  /** Nome legível da etapa, salvo só pra mostrar no painel/prompt sem refetch. */
  statusLabel?: string;
}

export interface TransferParams {
  includeSummary: boolean;
}

export interface SummarizeToNoteParams {
  /** Dica opcional do que destacar no resumo (ex: "foco em queixa/sintomas"). */
  focusHint?: string;
}

export type ActionParams =
  | AddTagParams
  | MoveStageParams
  | TransferParams
  | SummarizeToNoteParams
  | Record<string, never>;

/** Uma ação dentro de uma regra (array element). */
export interface ActionStep {
  kind: ActionKind;
  params: ActionParams;
}

export interface ActionInput {
  conditionDescription: string;
  actions: ActionStep[];
  notes?: string | null;
  enabled?: boolean;
}

/**
 * Lê o array de ações de uma UnitAction. Se `actions` estiver vazio (regra
 * antiga sem backfill), cai pro par legado `actionKind` + `actionParams`.
 * Garante que o resto do código nunca precise lidar com 2 formatos.
 */
export function readActions(row: UnitAction): ActionStep[] {
  const arr = Array.isArray(row.actions) ? (row.actions as unknown as ActionStep[]) : [];
  if (arr.length > 0) return arr;
  if (row.actionKind && row.actionKind.trim().length > 0) {
    return [
      {
        kind: row.actionKind as ActionKind,
        params: (row.actionParams as ActionParams) ?? {},
      },
    ];
  }
  return [];
}

export async function listActions(unitId: string): Promise<UnitAction[]> {
  return prisma.unitAction.findMany({
    where: { unitId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function listEnabledActions(unitId: string): Promise<UnitAction[]> {
  return prisma.unitAction.findMany({
    where: { unitId, enabled: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createAction(unitId: string, input: ActionInput): Promise<UnitAction> {
  return prisma.unitAction.create({
    data: {
      unitId,
      conditionDescription: input.conditionDescription,
      actions: input.actions as unknown as object,
      // Legados: ficam com a primeira ação do array só pra preservar
      // compatibilidade temporária (read paths que ainda dependem disso
      // não quebram caso a migração ainda esteja sendo aplicada em prod).
      actionKind: input.actions[0]?.kind ?? '',
      actionParams: (input.actions[0]?.params as object) ?? {},
      notes: input.notes ?? null,
      enabled: input.enabled ?? true,
    },
  });
}

export async function updateAction(
  actionId: string,
  input: Partial<ActionInput>,
): Promise<UnitAction> {
  return prisma.unitAction.update({
    where: { id: actionId },
    data: {
      ...(input.conditionDescription !== undefined && {
        conditionDescription: input.conditionDescription,
      }),
      ...(input.actions !== undefined && {
        actions: input.actions as unknown as object,
        actionKind: input.actions[0]?.kind ?? '',
        actionParams: (input.actions[0]?.params as object) ?? {},
      }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });
}

export async function deleteAction(actionId: string): Promise<void> {
  await prisma.unitAction.delete({ where: { id: actionId } });
}
