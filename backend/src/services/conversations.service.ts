import type { Conversation, Message } from '@prisma/client';
import { notifyDashboard } from '../lib/dashboard-webhook.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { pediuParaParar } from '../lib/pediu-para-parar.js';

/** Motivo gravado quando o paciente pede para não ser mais procurado. */
export const MOTIVO_PEDIU_PARA_PARAR = 'paciente pediu para não insistir';

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
  // Pedido de parar / de tempo. Fica AQUI porque `addMessage` é o ponto por onde passam as três
  // portas de entrada (salesbot, meta, widget): trava pendurada num controller só é como o
  // problema volta, e foi exatamente o que aconteceu com a leitura da conversa oficial.
  const pedido = p.role === 'user' ? pediuParaParar(p.content) : null;

  const message = await prisma.message.create({
    data: {
      conversationId: p.conversationId,
      traceId: p.traceId ?? null,
      role: p.role,
      content: p.content,
      // O "pediu tempo" viaja na mensagem que o disse, e é de lá que a régua o lê para pular
      // os degraus curtos. Não cabe na conversa: `followUpStoppedReason` a tiraria da fila de
      // vez, e adiar não é desistir.
      meta: (pedido === 'adiamento' ? { ...(p.meta ?? {}), pediuTempo: true } : p.meta) as
        | object
        | undefined,
    },
  });
  await prisma.conversation.update({
    where: { id: p.conversationId },
    data: {
      lastMessageAt: new Date(),
      ...(p.role === 'user' ? { followUpStep: 0, followUpLastAt: null } : {}),
      // Irritação cala a régua para sempre: é gente a um toque de bloquear o número — uma
      // paciente escreveu "insistência chata. Bloqueando em 3,2,1". Nada re-arma isso
      // sozinho depois; quem reabre é uma pessoa, de propósito.
      ...(pedido === 'irritacao' ? { followUpStoppedReason: MOTIVO_PEDIU_PARA_PARAR } : {}),
    },
  });
  if (pedido) {
    logger.info(
      { conversationId: p.conversationId, pedido },
      pedido === 'irritacao'
        ? 'régua calada: paciente pediu para não insistir'
        : 'régua adiada: paciente pediu tempo',
    );
  }

  void notifyDashboard(p.conversationId);

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
  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      unit: { select: { id: true, slug: true, name: true } },
    },
  });
  if (!conv) return null;

  const memory = await prisma.leadMemory
    .findUnique({
      where: { unitId_leadId: { unitId: conv.unitId, leadId: conv.leadId } },
      select: { summary: true, facts: true, updatedAt: true },
    })
    .catch(() => null);

  return { ...conv, memory };
}

export async function getRecentMessagesByLead(
  unitId: string,
  leadId: string,
  limit = 40,
): Promise<Array<{ role: string; content: string; createdAt: Date }>> {
  const conv = await prisma.conversation.findFirst({
    where: { unitId, leadId },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  if (!conv) return [];
  const msgs = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { role: true, content: true, createdAt: true },
  });
  return msgs.reverse();
}
