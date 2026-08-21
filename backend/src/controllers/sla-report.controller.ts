import type { Request, Response } from 'express';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { computeSlaReport } from '../services/sla-report.service.js';

export async function slaReportHandler(req: Request, res: Response): Promise<void> {
  if (!env.INTERNAL_API_KEY) {
    res.status(503).json({ error: 'integração desabilitada (INTERNAL_API_KEY não configurada)' });
    return;
  }
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const provided = req.header('x-internal-key') ?? bearer;
  if (provided !== env.INTERNAL_API_KEY) {
    res.status(401).json({ error: 'chave interna inválida (x-internal-key ou Authorization: Bearer)' });
    return;
  }

  try {
    const report = await computeSlaReport();
    res.json(report);
  } catch (err) {
    logger.error({ err: String(err) }, 'sla-report: erro inesperado');
    res.status(500).json({ error: 'falha ao computar o relatório de SLA' });
  }
}
