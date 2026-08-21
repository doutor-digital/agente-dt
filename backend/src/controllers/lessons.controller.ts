import type { Request, Response } from 'express';
import {
  listLessons,
  createLesson,
  updateLesson,
  deleteLesson,
} from '../services/lessons.service.js';
import { runReflectionForUnit } from '../services/reflection.service.js';
import { prisma } from '../lib/prisma.js';

export async function listLessonsHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const lessons = await listLessons(unitId);
  res.json({ lessons });
}

export async function createLessonHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json({ error: 'O aprendizado não pode ficar vazio.' });
    return;
  }
  const lesson = await createLesson(unitId, { content });
  res.json({ lesson });
}

export async function updateLessonHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const id = String(req.params.lessonId ?? '');
  const patch: { content?: string; enabled?: boolean } = {};
  if (typeof req.body?.content === 'string') patch.content = req.body.content;
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
  const count = await updateLesson(unitId, id, patch);
  if (count === 0) {
    res.status(404).json({ error: 'Aprendizado não encontrado.' });
    return;
  }
  res.json({ ok: true });
}

export async function deleteLessonHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const id = String(req.params.lessonId ?? '');
  const count = await deleteLesson(unitId, id);
  res.json({ ok: count > 0 });
}

export async function reflectLessonsHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'Unidade não encontrada.' });
    return;
  }
  const result = await runReflectionForUnit(unit);
  res.json(result);
}
