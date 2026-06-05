// ============================================================================
// dashboard-webhook.ts — Notifica o painel Doutor-Digital-Dash sobre cada
// mensagem nova (paciente ou IA).
//
// CONTRATO ESPERADO pelo destino (AgentWebhookController.cs no .NET):
//   POST {DASHBOARD_WEBHOOK_BASE_URL}/{unit.slug}
//   Content-Type: application/json
//   {
//     "conversationId": "<id estável da conversa>",
//     "agent": "agente-Dt",
//     "channel": "whatsapp" | "instagram" | ...,
//     "status": "active" | "closed",
//     "contact": { "name": "...", "phone": "..." },
//     "messages": [
//       { "role": "user" | "assistant" | "system",
//         "content": "...", "at": "ISO-8601" }
//     ]
//   }
//
// GARANTIAS
// ---------
// • Fire-and-forget — nunca bloqueia o agente. Promise é descartada com `void`.
// • Timeout curto (5s) — não segura a thread principal.
// • Falha silenciosa (logger.warn) — se o painel cair, o agente segue normal.
// • Idempotente no destino — o painel faz upsert por (TenantId, conversationId).
// ============================================================================

import axios from 'axios';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

/** Faz POST com o snapshot da conversa. NUNCA lança — sempre swallowed. */
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
      // Não temos "fechado" explicitamente; convertido (pipeline ganho) é o
      // sinal mais próximo de "encerrado bem-sucedido".
      status: conv.convertedAt ? 'closed' : 'active',
      contact: {
        name: conv.contactName ?? null,
        phone: conv.phone ?? null,
      },
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
    // Falha aqui é não-fatal por design — o painel é um observador.
    logger.warn(
      { err, conversationId },
      '[dashboard-webhook] falha ao notificar painel — ignorada (agente segue)',
    );
  }
}
