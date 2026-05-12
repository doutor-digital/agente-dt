// ============================================================================
// conversations.service.ts — Histórico cronológico por lead.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cada lead/contato tem UMA Conversation por Unit (unique [unitId, leadId]).
// Toda mensagem (paciente OU IA) vira uma Message dentro dessa Conversation.
//
// Por que separado de ExecutionTrace?
//   - Trace = uma execução do agente (pode envolver várias chamadas LLM).
//   - Conversation = visão "WhatsApp-like": mensagens em ordem cronológica.
// O dashboard tem ambas as visões: timeline técnica (trace) e chat (conversa).
//
// `traceId` opcional na Message permite drill-down: clicando numa resposta
// da IA, vai pro feed de raciocínio que a gerou.
// ============================================================================

import type { Conversation, Message } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export interface UpsertConversationParams {
  unitId: string;
  leadId: string;
  contactName?: string | null;
  phone?: string | null;
  channel?: string;
}

export async function upsertConversation(p: UpsertConversationParams): Promise<Conversation> {
  return prisma.conversation.upsert({
    where: { unitId_leadId: { unitId: p.unitId, leadId: p.leadId } },
    update: {
      ...(p.contactName !== undefined && { contactName: p.contactName }),
      ...(p.phone !== undefined && { phone: p.phone }),
      ...(p.channel && { channel: p.channel }),
      lastMessageAt: new Date(),
    },
    create: {
      unitId: p.unitId,
      leadId: p.leadId,
      contactName: p.contactName ?? null,
      phone: p.phone ?? null,
      channel: p.channel ?? 'kommo',
    },
  });
}

export interface AddMessageParams {
  conversationId: string;
  traceId?: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta?: Record<string, unknown>;
}

export async function addMessage(p: AddMessageParams): Promise<Message> {
  const message = await prisma.message.create({
    data: {
      conversationId: p.conversationId,
      traceId: p.traceId ?? null,
      role: p.role,
      content: p.content,
      meta: p.meta as object | undefined,
    },
  });
  // Toca o lastMessageAt da conversa.
  await prisma.conversation.update({
    where: { id: p.conversationId },
    data: { lastMessageAt: new Date() },
  });
  return message;
}

export async function listConversations(unitId: string | null, limit = 50) {
  return prisma.conversation.findMany({
    where: unitId ? { unitId } : undefined,
    orderBy: { lastMessageAt: 'desc' },
    take: limit,
    select: {
      id: true,
      unitId: true,
      leadId: true,
      contactName: true,
      phone: true,
      channel: true,
      lastMessageAt: true,
      createdAt: true,
      _count: { select: { messages: true } },
    },
  });
}

export async function getConversation(id: string) {
  return prisma.conversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      unit: { select: { id: true, slug: true, name: true } },
    },
  });
}
