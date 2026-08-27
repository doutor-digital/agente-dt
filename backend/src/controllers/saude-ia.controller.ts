import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { montarSaudeIA, resumirSaude } from '../services/saude-ia.service.js';

/**
 * Retrato do que a IA tem, do que está ligado e do que falta — pra tela do
 * console. Nasceu porque recurso pronto e desligado custou mais caro aqui que
 * recurso inexistente: ninguém lembra do que não vê.
 */
export async function saudeIaHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const grupos = montarSaudeIA(unit);
  res.json({ unitId, slug: unit.slug, resumo: resumirSaude(grupos), grupos });
}
