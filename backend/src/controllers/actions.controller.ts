// ============================================================================
// actions.controller.ts — endpoints REST de UnitAction (regras quando→faça).
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
} from '../services/actions.service.js';
import { logger } from '../lib/logger.js';

const ACTION_KINDS: ActionKind[] = [
  'add_tag',
  'move_stage',
  'transfer_with_permission',
  'transfer_without_permission',
];

// Params depende do kind — usamos validação por união discriminada.
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

const actionInputSchema = z
  .object({
    conditionDescription: z.string().min(3).max(2000),
    actionKind: z.enum(ACTION_KINDS as [ActionKind, ...ActionKind[]]),
    actionParams: z.record(z.string(), z.unknown()).default({}),
    notes: z.string().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.actionKind === 'add_tag') {
      const r = addTagParams.safeParse(data.actionParams);
      if (!r.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['actionParams'],
          message: `add_tag exige { tags: string[] } — ${r.error.message}`,
        });
      }
    } else if (data.actionKind === 'move_stage') {
      const r = moveStageParams.safeParse(data.actionParams);
      if (!r.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['actionParams'],
          message: `move_stage exige { statusId: number, pipelineId?: number } — ${r.error.message}`,
        });
      }
    } else if (
      data.actionKind === 'transfer_with_permission' ||
      data.actionKind === 'transfer_without_permission'
    ) {
      const r = transferParams.safeParse(data.actionParams);
      if (!r.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['actionParams'],
          message: `transfer_* exige { includeSummary: boolean }`,
        });
      }
    }
  });

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
    const action = await createAction(unitId, parsed.data as ActionInput);
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
  // Update aceita parcial; revalida o kind+params se um dos dois vier.
  const parsed = z
    .object({
      conditionDescription: z.string().min(3).max(2000).optional(),
      actionKind: z
        .enum(ACTION_KINDS as [ActionKind, ...ActionKind[]])
        .optional(),
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
    const action = await updateAction(actionId, parsed.data as Partial<ActionInput>);
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
