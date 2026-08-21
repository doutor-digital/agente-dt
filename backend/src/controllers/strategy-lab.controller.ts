import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { runStrategyLab, marcarEscolha } from '../services/strategy-lab.service.js';

export async function runStrategyLabHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const conversationId = String(req.body?.conversationId ?? '').trim();
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId é obrigatório.' });
    return;
  }
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'Unidade não encontrada.' });
    return;
  }

  const out = await runStrategyLab({
    unit,
    conversationId,
    ownerNote: typeof req.body?.ownerNote === 'string' ? req.body.ownerNote : null,
  });
  if (!out) {
    res.status(404).json({ error: 'Conversa não encontrada nesta unidade.' });
    return;
  }
  if (out.status === 'failed') {
    res.status(502).json({ error: 'Não consegui gerar as sugestões agora. Tente de novo.' });
    return;
  }
  res.json(out);
}

export async function chooseStrategyHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const runId = String(req.params.runId ?? '');
  const texto = String(req.body?.texto ?? '');
  const ok = await marcarEscolha(unitId, runId, texto);
  res.json({ ok });
}
