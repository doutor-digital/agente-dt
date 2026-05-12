// ============================================================================
// conversations.controller.ts — API REST do histórico de chat por lead.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Endpoints simples: lista conversas (resumo) e detalhe com todas as
// mensagens em ordem cronológica. Filtragem por unitId.
// ============================================================================

import type { Request, Response } from 'express';
import { getConversation, listConversations } from '../services/conversations.service.js';

export async function listConversationsHandler(req: Request, res: Response): Promise<void> {
  const unitId = (req.query.unitId as string | undefined) ?? null;
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const conversations = await listConversations(unitId, limit);
  res.json({ conversations });
}

export async function getConversationHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const conv = await getConversation(id);
  if (!conv) {
    res.status(404).json({ error: 'conversation_not_found' });
    return;
  }
  res.json({ conversation: conv });
}
