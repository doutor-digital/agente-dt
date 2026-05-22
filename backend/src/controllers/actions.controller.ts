// ============================================================================
// actions.controller.ts — endpoints REST de UnitAction (regras quando→faça).
//
// Formato API atual: cada regra tem `actions: Array<{ kind, params }>`.
// O cliente legado (que mandava `actionKind` + `actionParams`) ainda é
// aceito e convertido internamente — fica transparente até o front atualizar.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createAction,
  deleteAction,
  listActions,
  updateAction,
  type ActionInput,
  type ActionKind,
  type ActionStep,
} from '../services/actions.service.js';
import { logger } from '../lib/logger.js';

const ACTION_KINDS: ActionKind[] = [
  'add_tag',
  'move_stage',
  'transfer_with_permission',
  'transfer_without_permission',
  'summarize_to_note',
  'send_message',
  'respond_with_intent',
  'create_task',
  'assign_responsible',
  'remove_tag',
  'set_lead_value',
  'mark_lead_status',
  'move_pipeline',
  'pause_ai',
];

// Params validators por kind.
const addTagParams = z.object({
  tags: z.array(z.string().min(1).max(80)).min(1).max(10),
});
const moveStageParams = z.object({
  statusId: z.coerce.number().int().positive(),
  pipelineId: z.coerce.number().int().positive().optional(),
  statusLabel: z.string().max(120).optional(),
});
const transferParams = z.object({
  includeSummary: z.boolean().default(true),
});
const summarizeParams = z.object({
  focusHint: z.string().max(400).optional(),
});
const sendMessageParams = z.object({
  text: z.string().min(1, 'mensagem vazia').max(2000),
});
const respondWithIntentParams = z.object({
  instruction: z.string().min(5, 'orientação muito curta').max(2000),
});
const createTaskParams = z.object({
  text: z.string().min(3).max(500),
  deadlineMinutes: z.coerce.number().int().positive().max(60 * 24 * 30),
  responsibleUserId: z.coerce.number().int().positive().optional(),
  responsibleUserName: z.string().max(120).optional(),
});
const assignResponsibleParams = z.object({
  userId: z.coerce.number().int().positive(),
  userName: z.string().max(120).optional(),
});
const removeTagParams = z.object({
  tag: z.string().min(1).max(80),
});
const setLeadValueParams = z.object({
  price: z.coerce.number().nonnegative().max(10_000_000),
});
const markLeadStatusParams = z.object({
  status: z.enum(['won', 'lost']),
  lossReasonId: z.coerce.number().int().positive().optional(),
  lossReasonLabel: z.string().max(120).optional(),
});
const movePipelineParams = z.object({
  pipelineId: z.coerce.number().int().positive(),
  pipelineLabel: z.string().max(120).optional(),
  statusId: z.coerce.number().int().positive().optional(),
  statusLabel: z.string().max(120).optional(),
});
const pauseAiParams = z.object({
  moveToStageId: z.coerce.number().int().positive().optional(),
  moveToPipelineId: z.coerce.number().int().positive().optional(),
  moveToStageLabel: z.string().max(120).optional(),
});

function validateActionStep(step: { kind: string; params: unknown }, ctx: z.RefinementCtx, idx: number) {
  const path: (string | number)[] = ['actions', idx, 'params'];
  if (step.kind === 'add_tag') {
    const r = addTagParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `add_tag exige { tags: string[] } — ${r.error.message}` });
  } else if (step.kind === 'move_stage') {
    const r = moveStageParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `move_stage exige { statusId: number } — ${r.error.message}` });
  } else if (step.kind === 'transfer_with_permission' || step.kind === 'transfer_without_permission') {
    const r = transferParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `transfer_* exige { includeSummary: boolean }` });
  } else if (step.kind === 'summarize_to_note') {
    const r = summarizeParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `summarize_to_note: focusHint inválido` });
  } else if (step.kind === 'send_message') {
    const r = sendMessageParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `send_message exige { text: string } não vazio (até 2000 chars)` });
  } else if (step.kind === 'respond_with_intent') {
    const r = respondWithIntentParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `respond_with_intent exige { instruction: string } com pelo menos 5 chars (até 2000)` });
  } else if (step.kind === 'create_task') {
    const r = createTaskParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `create_task exige { text, deadlineMinutes } — ${r.error.message}` });
  } else if (step.kind === 'assign_responsible') {
    const r = assignResponsibleParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `assign_responsible exige { userId } — ${r.error.message}` });
  } else if (step.kind === 'remove_tag') {
    const r = removeTagParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `remove_tag exige { tag: string }` });
  } else if (step.kind === 'set_lead_value') {
    const r = setLeadValueParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `set_lead_value exige { price: number >= 0 }` });
  } else if (step.kind === 'mark_lead_status') {
    const r = markLeadStatusParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `mark_lead_status exige { status: 'won'|'lost' }` });
  } else if (step.kind === 'move_pipeline') {
    const r = movePipelineParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `move_pipeline exige { pipelineId: number }` });
  } else if (step.kind === 'pause_ai') {
    const r = pauseAiParams.safeParse(step.params);
    if (!r.success) ctx.addIssue({ code: 'custom', path, message: `pause_ai aceita opcionalmente { moveToStageId }` });
  }
}

const actionStepSchema = z.object({
  kind: z.enum(ACTION_KINDS as [ActionKind, ...ActionKind[]]),
  params: z.record(z.string(), z.unknown()).default({}),
});

const actionInputSchema = z
  .object({
    conditionDescription: z.string().min(3).max(2000),
    /** Novo formato. Se vier vazio e os campos legados vierem, convertemos. */
    actions: z.array(actionStepSchema).max(8).optional(),
    /** @deprecated — clientes antigos. */
    actionKind: z.enum(ACTION_KINDS as [ActionKind, ...ActionKind[]]).optional(),
    /** @deprecated — clientes antigos. */
    actionParams: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const actions = data.actions ?? [];
    // Aceita formato legado: { actionKind, actionParams } vira [1 step].
    if (actions.length === 0 && data.actionKind) {
      const step = { kind: data.actionKind, params: data.actionParams ?? {} };
      validateActionStep(step, ctx, 0);
      return;
    }
    if (actions.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: 'pelo menos 1 ação é obrigatória' });
      return;
    }
    actions.forEach((step, i) => validateActionStep(step, ctx, i));
  });

/** Normaliza o body validado num ActionInput canônico (array). */
function toActionInput(parsed: z.infer<typeof actionInputSchema>): ActionInput {
  const actions: ActionStep[] =
    parsed.actions && parsed.actions.length > 0
      ? (parsed.actions as ActionStep[])
      : [
          {
            kind: parsed.actionKind as ActionKind,
            params: (parsed.actionParams ?? {}) as ActionStep['params'],
          },
        ];
  return {
    conditionDescription: parsed.conditionDescription,
    actions,
    notes: parsed.notes ?? null,
    enabled: parsed.enabled,
  };
}

export async function listActionsHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  if (!unitId) {
    res.status(400).json({ error: 'unit id é obrigatório' });
    return;
  }
  const actions = await listActions(unitId);
  res.json({ actions });
}

export async function createActionHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  if (!unitId) {
    res.status(400).json({ error: 'unit id é obrigatório' });
    return;
  }
  const parsed = actionInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }
  try {
    const action = await createAction(unitId, toActionInput(parsed.data));
    res.status(201).json({ action });
  } catch (err) {
    logger.error({ err, unitId }, 'createAction failed');
    res.status(500).json({ error: 'falha ao criar ação' });
  }
}

export async function updateActionHandler(req: Request, res: Response): Promise<void> {
  const actionId = String(req.params.actionId ?? '');
  if (!actionId) {
    res.status(400).json({ error: 'actionId é obrigatório' });
    return;
  }
  // Update aceita parcial; valida o que vier.
  const parsed = z
    .object({
      conditionDescription: z.string().min(3).max(2000).optional(),
      actions: z.array(actionStepSchema).max(8).optional(),
      actionKind: z.enum(ACTION_KINDS as [ActionKind, ...ActionKind[]]).optional(),
      actionParams: z.record(z.string(), z.unknown()).optional(),
      notes: z.string().max(2000).nullable().optional(),
      enabled: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }
  try {
    const data = parsed.data;
    const patch: Partial<ActionInput> = {};
    if (data.conditionDescription !== undefined) patch.conditionDescription = data.conditionDescription;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.actions !== undefined) {
      patch.actions = data.actions as ActionStep[];
    } else if (data.actionKind !== undefined) {
      patch.actions = [
        {
          kind: data.actionKind as ActionKind,
          params: (data.actionParams ?? {}) as ActionStep['params'],
        },
      ];
    }
    const action = await updateAction(actionId, patch);
    res.json({ action });
  } catch (err) {
    logger.error({ err, actionId }, 'updateAction failed');
    res.status(500).json({ error: 'falha ao atualizar ação' });
  }
}

export async function deleteActionHandler(req: Request, res: Response): Promise<void> {
  const actionId = String(req.params.actionId ?? '');
  if (!actionId) {
    res.status(400).json({ error: 'actionId é obrigatório' });
    return;
  }
  try {
    await deleteAction(actionId);
    res.status(204).end();
  } catch (err) {
    logger.error({ err, actionId }, 'deleteAction failed');
    res.status(500).json({ error: 'falha ao excluir ação' });
  }
}
