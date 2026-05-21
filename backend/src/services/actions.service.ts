// ============================================================================
// actions.service.ts — CRUD de UnitAction (regras "quando → faça").
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cada UnitAction é uma instrução semântica injetada no prompt da IA. O
// prompt-composer chama listEnabledActions() e renderiza cada regra como
// um item da seção "AÇÕES CONFIGURADAS".
//
// A IA decide *quando* aplicar a regra (matching semântico) e executa via
// tools existentes:
//   - add_tag                     → tool aplicar_tag
//   - move_stage                  → tool mover_etapa
//   - transfer_with_permission    → pede ok ao cliente, depois pausar_ia
//   - transfer_without_permission → pausar_ia direto
// ============================================================================

import type { UnitAction } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type ActionKind =
  | 'add_tag'
  | 'move_stage'
  | 'transfer_with_permission'
  | 'transfer_without_permission';

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

export type ActionParams =
  | AddTagParams
  | MoveStageParams
  | TransferParams
  | Record<string, never>;

export interface ActionInput {
  conditionDescription: string;
  actionKind: ActionKind;
  actionParams: ActionParams;
  notes?: string | null;
  enabled?: boolean;
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
      actionKind: input.actionKind,
      actionParams: input.actionParams as object,
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
      ...(input.actionKind !== undefined && { actionKind: input.actionKind }),
      ...(input.actionParams !== undefined && { actionParams: input.actionParams as object }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });
}

export async function deleteAction(actionId: string): Promise<void> {
  await prisma.unitAction.delete({ where: { id: actionId } });
}
