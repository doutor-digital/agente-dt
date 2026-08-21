import type { UnitAction } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type ActionKind =
  | 'add_tag'
  | 'move_stage'
  | 'transfer_with_permission'
  | 'transfer_without_permission'
  | 'summarize_to_note'
  | 'send_message'
  | 'respond_with_intent'
  | 'create_task'
  | 'assign_responsible'
  | 'remove_tag'
  | 'set_lead_value'
  | 'mark_lead_status'
  | 'move_pipeline'
  | 'pause_ai'
  | 'pause_in_stages';

export interface AddTagParams {
  tags: string[];
}

export interface MoveStageParams {
  statusId: number;
  pipelineId?: number;
  statusLabel?: string;
}

export interface TransferParams {
  includeSummary: boolean;
}

export interface SummarizeToNoteParams {
  focusHint?: string;
}

export interface SendMessageParams {
  text: string;
}

export interface RespondWithIntentParams {
  instruction: string;
}

export interface CreateTaskParams {
  text: string;
  deadlineMinutes: number;
  responsibleUserId?: number;
  responsibleUserName?: string;
}

export interface AssignResponsibleParams {
  userId: number;
  userName?: string;
}

export interface RemoveTagParams {
  tag: string;
}

export interface SetLeadValueParams {
  price: number;
}

export interface MarkLeadStatusParams {
  status: 'won' | 'lost';
  lossReasonId?: number;
  lossReasonLabel?: string;
}

export interface MovePipelineParams {
  pipelineId: number;
  pipelineLabel?: string;
  statusId?: number;
  statusLabel?: string;
}

export interface PauseAiParams {
  moveToStageId?: number;
  moveToPipelineId?: number;
  moveToStageLabel?: string;
}

export interface PauseInStagesParams {
  stages: Array<{
    statusId: number;
    pipelineId?: number;
    statusLabel?: string;
    pipelineLabel?: string;
  }>;
}

export type ActionParams =
  | AddTagParams
  | MoveStageParams
  | TransferParams
  | SummarizeToNoteParams
  | SendMessageParams
  | RespondWithIntentParams
  | CreateTaskParams
  | AssignResponsibleParams
  | RemoveTagParams
  | SetLeadValueParams
  | MarkLeadStatusParams
  | MovePipelineParams
  | PauseAiParams
  | PauseInStagesParams
  | Record<string, never>;

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

import type { GlobalAction } from '@prisma/client';

export async function listGlobalActions(): Promise<GlobalAction[]> {
  return prisma.globalAction.findMany({
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function listEnabledGlobalActions(): Promise<GlobalAction[]> {
  return prisma.globalAction.findMany({
    where: { enabled: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function createGlobalAction(input: ActionInput & { priority?: number }): Promise<GlobalAction> {
  return prisma.globalAction.create({
    data: {
      conditionDescription: input.conditionDescription,
      actions: input.actions as unknown as object,
      notes: input.notes ?? null,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
    },
  });
}

export async function updateGlobalAction(
  actionId: string,
  input: Partial<ActionInput & { priority: number }>,
): Promise<GlobalAction> {
  return prisma.globalAction.update({
    where: { id: actionId },
    data: {
      ...(input.conditionDescription !== undefined && {
        conditionDescription: input.conditionDescription,
      }),
      ...(input.actions !== undefined && { actions: input.actions as unknown as object }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.priority !== undefined && { priority: input.priority }),
    },
  });
}

export async function deleteGlobalAction(actionId: string): Promise<void> {
  await prisma.globalAction.delete({ where: { id: actionId } });
}

export function readGlobalActionSteps(row: GlobalAction): ActionStep[] {
  const raw = row.actions;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw as unknown as ActionStep[];
  }
  return [];
}

export async function getPausedStagesGlobalSet(): Promise<Set<string>> {
  const globals = await prisma.globalAction.findMany({
    where: { enabled: true },
    select: { actions: true },
  });
  const set = new Set<string>();
  for (const g of globals) {
    const arr = Array.isArray(g.actions) ? (g.actions as unknown as ActionStep[]) : [];
    for (const step of arr) {
      if (step.kind !== 'pause_in_stages') continue;
      const params = step.params as PauseInStagesParams | undefined;
      const stages = params?.stages ?? [];
      for (const s of stages) {
        if (!s || !Number.isFinite(s.statusId)) continue;
        const key = s.pipelineId ? `${s.pipelineId}:${s.statusId}` : `*:${s.statusId}`;
        set.add(key);
      }
    }
  }
  return set;
}
