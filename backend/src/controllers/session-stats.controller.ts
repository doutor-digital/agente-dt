// ============================================================================
// session-stats.controller.ts — endpoint máquina-a-máquina pro n8n.
//
// GET /integrations/:unitSlug/session-stats/:leadId
//   Header obrigatório: x-internal-key: <INTERNAL_API_KEY>
//
// Devolve os campos de sessão DERIVADOS da franquia (ver session-stats.service).
// O n8n consome isto e dá PATCH nos campos do Kommo — "backend lê, n8n escreve".
// Rota PÚBLICA (registrada antes do requireAuth), protegida só pela chave.
// ============================================================================

import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { computeSessionStats } from '../services/session-stats.service.js';

export async function sessionStatsHandler(req: Request, res: Response): Promise<void> {
  // 1) Chave interna. Sem env configurada, o endpoint fica desligado.
  if (!env.INTERNAL_API_KEY) {
    res.status(503).json({ error: 'integração desabilitada (INTERNAL_API_KEY não configurada)' });
    return;
  }
  // Aceita a chave por header custom (x-internal-key) OU Authorization: Bearer.
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const provided = req.header('x-internal-key') ?? bearer;
  if (provided !== env.INTERNAL_API_KEY) {
    res.status(401).json({ error: 'chave interna inválida (x-internal-key ou Authorization: Bearer)' });
    return;
  }

  const unitSlug = String(req.params.unitSlug);
  const leadId = Number(req.params.leadId);
  if (!Number.isInteger(leadId) || leadId <= 0) {
    res.status(400).json({ error: 'leadId inválido' });
    return;
  }

  const unit = await prisma.unit.findFirst({ where: { slug: unitSlug } });
  if (!unit) {
    res.status(404).json({ error: `unidade '${unitSlug}' não encontrada` });
    return;
  }
  if (!unit.spineToken) {
    res.status(409).json({ error: 'unidade sem token da API da franquia (Spine)' });
    return;
  }

  // idClient opcional na query — quem chama (n8n) já leu o campo na listagem e
  // passa direto, pra o endpoint NÃO precisar de getLead (evita rate-limit).
  const idClientRaw = Number(req.query.idClient);
  const idClient = Number.isInteger(idClientRaw) && idClientRaw > 0 ? idClientRaw : undefined;

  try {
    const stats = await computeSessionStats(unit, leadId, idClient);
    res.json({ unit: unit.slug, leadId, ...stats });
  } catch (err) {
    logger.error({ err: String(err), unit: unitSlug, leadId }, 'session-stats: erro inesperado');
    res.status(500).json({ error: 'falha ao computar estatísticas de sessão' });
  }
}
