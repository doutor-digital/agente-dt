// ============================================================================
// templates.controller.ts — Endpoints CRUD de MessageTemplate.
// Todos sob /units/:id/templates.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger.js';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
} from '../services/templates.service.js';

const templateInputSchema = z.object({
  name: z.string().min(1).max(80),
  triggerKeywords: z.array(z.string().min(1).max(50)).max(30).default([]),
  response: z.string().min(1).max(2000),
});

export async function listTemplatesHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const templates = await listTemplates(id);
  res.json({ templates });
}

export async function createTemplateHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const parsed = templateInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  try {
    const template = await createTemplate(id, parsed.data);
    res.status(201).json({ template });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'template_name_duplicate' });
      return;
    }
    logger.error({ err }, 'create template failed');
    res.status(500).json({ error: 'create_failed' });
  }
}

export async function updateTemplateHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const templateId = String(req.params.templateId ?? '');
  const parsed = templateInputSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  try {
    const template = await updateTemplate(id, templateId, parsed.data);
    res.json({ template });
  } catch (err) {
    logger.error({ err }, 'update template failed');
    res.status(500).json({ error: 'update_failed' });
  }
}

export async function deleteTemplateHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const templateId = String(req.params.templateId ?? '');
  try {
    await deleteTemplate(id, templateId);
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'delete template failed');
    res.status(500).json({ error: 'delete_failed' });
  }
}
