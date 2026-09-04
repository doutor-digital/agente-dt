import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { calcularResultados, resumoResultados } from '../services/resultados.service.js';

/** GET /units/:id/resultados?days=60 — o livro de resultados resumido da unidade. */
export async function resultadosHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const dias = Math.min(Math.max(Number(req.query.days ?? 60), 1), 365);
  try {
    const resumo = await resumoResultados(id, dias);
    res.json(resumo);
  } catch (err) {
    logger.error({ err: String(err), unitId: id }, 'resultados: falha no resumo');
    res.status(500).json({ error: 'resultados_failed' });
  }
}

/** POST /units/:id/resultados/recalcular?days=60&limit=500 — força o recálculo (backfill). */
export async function recalcularResultadosHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const dias = Math.min(Math.max(Number(req.query.days ?? 60), 1), 365);
  const limite = Math.min(Math.max(Number(req.query.limit ?? 500), 1), 5000);
  try {
    const unit = await prisma.unit.findUnique({ where: { id } });
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const r = await calcularResultados(unit, { dias, limite, apenasPendentes: false });
    res.json({ ok: true, ...r, resumo: await resumoResultados(id, dias) });
  } catch (err) {
    logger.error({ err: String(err), unitId: id }, 'resultados: falha no recálculo');
    res.status(500).json({ error: 'recalculo_failed' });
  }
}
