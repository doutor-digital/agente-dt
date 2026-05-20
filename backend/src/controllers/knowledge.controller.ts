// ============================================================================
// knowledge.controller.ts — CRUD da base de conhecimento (RAG).
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  createKnowledge,
  deleteKnowledge,
  listKnowledge,
  updateKnowledge,
} from '../services/knowledge.service.js';

const inputSchema = z.object({
  question: z.string().min(1).max(2000),
  answer: z.string().min(1).max(8000),
});

export async function listKnowledgeHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const items = await listKnowledge(id);
  res.json({ entries: items });
}

export async function createKnowledgeHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.openaiApiKey) {
    res.status(400).json({ error: 'openai_key_missing' });
    return;
  }
  try {
    const entry = await createKnowledge(unit, parsed.data);
    res.status(201).json({ entry });
  } catch (err) {
    logger.error({ err }, 'create knowledge failed');
    res.status(500).json({ error: 'create_failed', message: (err as Error).message });
  }
}

export async function updateKnowledgeHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const entryId = String(req.params.entryId ?? '');
  const parsed = inputSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  try {
    const entry = await updateKnowledge(unit, entryId, parsed.data);
    res.json({ entry });
  } catch (err) {
    const msg = (err as Error).message;
    const status = msg === 'entry_not_found' ? 404 : 500;
    logger.warn({ err, entryId }, 'update knowledge failed');
    res.status(status).json({ error: msg });
  }
}

export async function deleteKnowledgeHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const entryId = String(req.params.entryId ?? '');
  try {
    await deleteKnowledge(id, entryId);
    res.status(204).end();
  } catch (err) {
    logger.warn({ err, entryId }, 'delete knowledge failed');
    res.status(500).json({ error: 'delete_failed' });
  }
}
