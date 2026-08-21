import axios from 'axios';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

export async function notifyDashboard(conversationId: string): Promise<void> {
  if (!env.DASHBOARD_WEBHOOK_BASE_URL) return;

  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        unit: { select: { slug: true, isActive: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { role: true, content: true, createdAt: true },
        },
      },
    });

    if (!conv || !conv.unit?.slug || !conv.unit.isActive) return;

    const payload = {
      conversationId: conv.id,
      agent: 'agente-Dt',
      channel: conv.channel ?? 'whatsapp',
      status: conv.convertedAt ? 'closed' : 'active',
      contact: {
        name: conv.contactName ?? null,
        phone: conv.phone ?? null,
      },
      leadExternalId: conv.leadId,
      startedAt: conv.createdAt.toISOString(),
      endedAt: conv.convertedAt?.toISOString() ?? null,
      messages: conv.messages.map((m) => ({
        role: m.role,
        content: m.content,
        at: m.createdAt.toISOString(),
      })),
    };

    await axios.post(`${env.DASHBOARD_WEBHOOK_BASE_URL}/${conv.unit.slug}`, payload, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    logger.warn(
      { err, conversationId },
      '[dashboard-webhook] falha ao notificar painel — ignorada (agente segue)',
    );
  }
}
