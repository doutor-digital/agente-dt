// ============================================================================
// global-actions.controller.ts — REST CRUD de GlobalAction (regras globais).
//
// Apenas SUPER_ADMIN pode listar/criar/editar/deletar. As regras valem pra
// TODAS as units e são injetadas no prompt-composer antes das UnitActions.
//
// Validação dos `actions[]` segue o mesmo set de kinds do actions.controller —
// reaproveitamos o validador via re-export pra evitar drift.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createGlobalAction,
  deleteGlobalAction,
  listGlobalActions,
  updateGlobalAction,
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
  'pause_in_stages',
];

const actionStepSchema = z.object({
  kind: z.enum(ACTION_KINDS as [ActionKind, ...ActionKind[]]),
  params: z.record(z.string(), z.unknown()).default({}),
});

const createSchema = z.object({
  conditionDescription: z.string().min(3).max(2000),
  actions: z.array(actionStepSchema).min(1).max(8),
  notes: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
});

const patchSchema = z.object({
  conditionDescription: z.string().min(3).max(2000).optional(),
  actions: z.array(actionStepSchema).min(1).max(8).optional(),
  notes: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
});

export async function listGlobalActionsHandler(_req: Request, res: Response): Promise<void> {
  const actions = await listGlobalActions();
  res.json({ actions });
}

export async function createGlobalActionHandler(req: Request, res: Response): Promise<void> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }
  try {
    const input: ActionInput & { priority?: number } = {
      conditionDescription: parsed.data.conditionDescription,
      actions: parsed.data.actions as ActionStep[],
      notes: parsed.data.notes ?? null,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
    };
    const action = await createGlobalAction(input);
    res.status(201).json({ action });
  } catch (err) {
    logger.error({ err }, 'createGlobalAction failed');
    res.status(500).json({ error: 'falha ao criar regra global' });
  }
}

export async function updateGlobalActionHandler(req: Request, res: Response): Promise<void> {
  const actionId = String(req.params.actionId ?? '');
  if (!actionId) {
    res.status(400).json({ error: 'actionId é obrigatório' });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }
  try {
    const patch: Partial<ActionInput & { priority: number }> = {};
    if (parsed.data.conditionDescription !== undefined)
      patch.conditionDescription = parsed.data.conditionDescription;
    if (parsed.data.actions !== undefined) patch.actions = parsed.data.actions as ActionStep[];
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
    const action = await updateGlobalAction(actionId, patch);
    res.json({ action });
  } catch (err) {
    logger.error({ err, actionId }, 'updateGlobalAction failed');
    res.status(500).json({ error: 'falha ao atualizar regra global' });
  }
}

export async function deleteGlobalActionHandler(req: Request, res: Response): Promise<void> {
  const actionId = String(req.params.actionId ?? '');
  if (!actionId) {
    res.status(400).json({ error: 'actionId é obrigatório' });
    return;
  }
  try {
    await deleteGlobalAction(actionId);
    res.status(204).end();
  } catch (err) {
    logger.error({ err, actionId }, 'deleteGlobalAction failed');
    res.status(500).json({ error: 'falha ao excluir regra global' });
  }
}
