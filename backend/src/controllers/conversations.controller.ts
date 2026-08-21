import type { Request, Response } from 'express';
import { getConversation, listConversations } from '../services/conversations.service.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export async function listConversationsHandler(req: Request, res: Response): Promise<void> {
  const unitId =
    req.user?.role === 'UNIT_ADMIN'
      ? (req.user.unitId ?? '__never_match__')
      : ((req.query.unitId as string | undefined) ?? null);
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
  if (req.user?.role === 'UNIT_ADMIN' && conv.unitId !== req.user.unitId) {
    res.status(404).json({ error: 'conversation_not_found' });
    return;
  }
  res.json({ conversation: conv });
}

export async function flagMessageHandler(req: Request, res: Response): Promise<void> {
  const messageId = String(req.params.messageId ?? '');
  const flagged = !!req.body?.flagged;

  if (req.user?.role === 'UNIT_ADMIN') {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { conversation: { select: { unitId: true } } },
    });
    if (!msg || msg.conversation.unitId !== req.user.unitId) {
      res.status(404).json({ error: 'message_not_found' });
      return;
    }
  }

  try {
    const msg = await prisma.message.update({
      where: { id: messageId },
      data: { flagged },
      select: { id: true, flagged: true, conversationId: true },
    });
    res.json({ message: msg });
  } catch (err) {
    logger.warn({ err, messageId }, 'flag message failed');
    res.status(404).json({ error: 'message_not_found' });
  }
}

export async function listFlaggedMessagesHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const messages = await prisma.message.findMany({
    where: {
      flagged: true,
      role: 'assistant',
      conversation: { unitId },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      content: true,
      createdAt: true,
      conversationId: true,
      conversation: { select: { contactName: true, leadId: true } },
    },
  });
  res.json({ messages });
}
