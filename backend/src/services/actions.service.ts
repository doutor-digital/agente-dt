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

export interface SendMessageParams {
  /** Texto exato que a IA deve enviar quando esta ação dispara. */
  text: string;
}

export interface RespondWithIntentParams {
  /**
   * Diretriz em PT-BR que a IA segue pra compor a resposta — sem reproduzir
   * literal, mas respeitando o conteúdo/intenção. Pode incluir lógica condicional
   * ("se paciente pedir alívio imediato, diga X"). Diferente de send_message
   * que é verbatim.
   */
  instruction: string;
}

export interface CreateTaskParams {
  text: string;
  /** Minutos a partir de "agora" pro deadline. Ex: 1440 = 1 dia. */
  deadlineMinutes: number;
  responsibleUserId?: number;
  responsibleUserName?: string;
}

export interface AssignResponsibleParams {
  userId: number;
  userName?: string;
}

export interface RemoveTagParams {
  /** Apenas 1 tag por step (consistente com o tool schema). */
  tag: string;
}

export interface SetLeadValueParams {
  /** Preço em reais (number). 1500 = R$1500,00. */
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
  /** Opcional. Se preenchido, também move o lead pra essa etapa quando pausar. */
  moveToStageId?: number;
  moveToPipelineId?: number;
  moveToStageLabel?: string;
}

/**
 * Pausa a IA quando o lead JÁ ESTÁ em uma das etapas listadas.
 *
 * NÃO é uma ação reativa (não vai pro prompt). É um GUARD avaliado no webhook
 * controller antes de invocar o agent: se o status atual do lead bate com
 * algum item de `stages`, pula `graph.invoke`. Use pra silenciar a IA em
 * etapas terminais (fechado/won/lost/handoff humano/etc.) sem precisar marcar
 * o campo "IA Pausada" lead a lead.
 *
 * `stages` deve ter pelo menos 1 item. `pipelineId` é opcional — quando
 * omitido, só `statusId` é comparado (útil quando IDs de etapa são únicos
 * globalmente na conta).
 */
export interface PauseInStagesParams {
  stages: Array<{
    statusId: number;
    pipelineId?: number;
    /** Nome amigável da etapa pra UI (não usado pela lógica). */
    statusLabel?: string;
    /** Nome do pipeline pra UI. */
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

// ===========================================================================
// GlobalAction — regras que valem pra TODAS as units (gerenciadas por admin).
// ===========================================================================

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

/** Lê o array de ações de uma GlobalAction. Mesma semântica do readActions de UnitAction. */
export function readGlobalActionSteps(row: GlobalAction): ActionStep[] {
  const raw = row.actions;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw as unknown as ActionStep[];
  }
  return [];
}

/**
 * Agrega o conjunto de etapas em que a IA deve ser pausada, lendo TODAS as
 * GlobalActions habilitadas com pelo menos um step kind === 'pause_in_stages'.
 *
 * Resultado: Set<"pipelineId:statusId" | "*:statusId"> pra lookup O(1) no
 * guard do webhook. Usar string composta evita confusão com IDs duplicados
 * entre pipelines.
 */
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
