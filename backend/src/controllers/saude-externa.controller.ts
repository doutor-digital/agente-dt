import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { consultarSaude } from '../lib/saude-externa.js';

/** Compara em tempo constante e sem vazar o tamanho do segredo. */
export function tokenConfere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) {
    // gasta o mesmo tempo mesmo assim
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * `GET /api/health/ia`: ok / degradado / fora, para o vigia externo (GitHub Actions). Não é o /health do orquestrador.
 *
 * FECHADO POR PADRÃO (OWASP A01/A02): sem `HEALTH_IA_TOKEN` no servidor a rota responde 404, e com ele exige o mesmo valor
 * no cabeçalho `X-Health-Token`. Os dados são só contagens, mas dizer de graça a qualquer um que a IA caiu, e quando, não
 * tem motivo para ser público. Falha de banco não vira 200: responde 503 com `estado: fora`.
 */
export async function saudeIaExternaHandler(req: Request, res: Response): Promise<void> {
  const esperado = (process.env.HEALTH_IA_TOKEN ?? '').trim();
  if (!esperado) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const recebido = String(req.header('x-health-token') ?? '');
  if (!recebido || !tokenConfere(recebido, esperado)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await consultarSaude());
  } catch (err) {
    logger.warn({ err: String(err) }, 'saude-ia externa: o banco não respondeu');
    res.status(503).json({ estado: 'fora', causa: 'indisponivel', motivo: 'banco de dados não respondeu' });
  }
}
