// ============================================================================
// webhook.controller.ts — Recebe webhooks do Kommo (multi-tenant).
//
// LÓGICA DE ENGENHARIA
// --------------------
// O Kommo timeoutsa webhooks em 30 segundos. LLM pode levar 5-15s. Padrão:
//   1. Recebe POST → valida payload mínimo + resolve Unit (do slug ou default).
//   2. Cria ExecutionTrace + abre Conversation se aplicável.
//   3. Retorna HTTP 200 IMEDIATAMENTE.
//   4. Em background, invoca o grafo. Atualiza trace ao final.
//
// IDEMPOTÊNCIA / DEDUP: confiamos no thread_id do LangGraph para o MVP.
// Em produção, usar `X-Webhook-Id` pra deduplicar.
// ============================================================================

import type { Request, Response } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildAgentGraph, buildThreadId } from '../agent/graph.js';
import { TraceRecorder, syncRecorderSequence } from '../agent/trace-recorder.js';
import { createKommoClient } from '../services/kommo.service.js';
import { findUnitBySlug, ensureDefaultUnit } from '../services/units.service.js';
import { addMessage, upsertConversation } from '../services/conversations.service.js';
import { judgeConversation } from '../services/conversation-judge.service.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema do payload do Kommo (CRM events + chat events).
// ---------------------------------------------------------------------------

const messageAddSchema = z.object({
  id: z.string().optional(),
  chat_id: z.string().optional(),
  talk_id: z.coerce.string().optional(),
  contact_id: z.coerce.string().optional(),
  text: z.string().optional(),
  element_id: z.coerce.number().optional(),
  entity_id: z.coerce.number().optional(),
  entity_type: z.string().optional(),
  type: z.string().optional(), // "incoming" | "outgoing"
  origin: z.string().optional(),
  author: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.string().optional(),
    })
    .partial()
    .optional(),
});

// Eventos de mudança de status do Kommo trazem id do lead + status_id atual
// (e opcionalmente old_status_id). É o gatilho de "conversão" se o status_id
// estiver em Unit.kommoWonStatusIds.
const leadStatusSchema = z.object({
  id: z.coerce.number(),
  status_id: z.coerce.number().optional(),
  old_status_id: z.coerce.number().optional(),
  pipeline_id: z.coerce.number().optional(),
});

const webhookSchema = z.object({
  leads: z
    .object({
      add: z.array(z.object({ id: z.coerce.number() })).optional(),
      update: z.array(z.object({ id: z.coerce.number() })).optional(),
      status: z.array(leadStatusSchema).optional(),
    })
    .optional(),
  message: z
    .object({
      add: z.array(messageAddSchema).optional(),
    })
    .optional(),
  // Fallback de teste: { leadId, text }
  leadId: z.coerce.number().optional(),
  text: z.string().optional(),
});

type ParsedWebhook = z.infer<typeof webhookSchema>;
type MessageEvent = z.infer<typeof messageAddSchema>;

function getIncomingMessage(parsed: ParsedWebhook): MessageEvent | null {
  const messages = parsed.message?.add ?? [];
  const incoming = messages.find((m) => (m.type ?? 'incoming') === 'incoming' && m.text);
  return incoming ?? null;
}

function extractLeadId(parsed: ParsedWebhook): number | null {
  if (parsed.leadId) return parsed.leadId;
  const msg = getIncomingMessage(parsed);
  if (msg?.entity_id) return msg.entity_id;
  if (msg?.element_id) return msg.element_id;
  const candidates = [
    parsed.leads?.add?.[0]?.id,
    parsed.leads?.update?.[0]?.id,
    parsed.leads?.status?.[0]?.id,
  ];
  return candidates.find((v): v is number => typeof v === 'number') ?? null;
}

interface ExtractedContext {
  humanMessage: string;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  contactName: string | null;
  isChatMessage: boolean;
}

function extractContext(parsed: ParsedWebhook, leadId: number): ExtractedContext {
  const msg = getIncomingMessage(parsed);
  if (msg?.text) {
    return {
      humanMessage: msg.text,
      chatId: msg.chat_id ?? null,
      talkId: msg.talk_id ?? null,
      contactId: msg.contact_id ?? null,
      contactName: msg.author?.name ?? null,
      isChatMessage: true,
    };
  }
  return {
    humanMessage: parsed.text ?? `Webhook recebido para lead ${leadId}. Analise e tome a melhor ação.`,
    chatId: null,
    talkId: null,
    contactId: null,
    contactName: null,
    isChatMessage: false,
  };
}

// ---------------------------------------------------------------------------
// Resolve a Unit pelo slug da rota ou cai pra default (retrocompat).
// ---------------------------------------------------------------------------

async function resolveUnit(req: Request): Promise<Unit | null> {
  const slug = req.params.unitSlug ? String(req.params.unitSlug) : '';
  if (slug) return findUnitBySlug(slug);
  return ensureDefaultUnit();
}

// ---------------------------------------------------------------------------
// Detecta entrada em etapa de "Ganho" do Kommo.
//
// Quando `leads.status[i].status_id` está em `unit.kommoWonStatusIds`, a
// Conversation correspondente é marcada como convertida e o juiz LLM é
// disparado em background. Idempotente — se a conversa já está convertida,
// não toca.
// ---------------------------------------------------------------------------

async function detectAndHandleConversion(
  unit: Unit,
  parsed: ParsedWebhook,
): Promise<{ converted: boolean; leadId: number | null; statusId: number | null }> {
  const wonSet = new Set(unit.kommoWonStatusIds);
  if (wonSet.size === 0) return { converted: false, leadId: null, statusId: null };

  const events = parsed.leads?.status ?? [];
  const wonEvent = events.find((e) => e.status_id !== undefined && wonSet.has(e.status_id));
  if (!wonEvent) return { converted: false, leadId: null, statusId: null };

  const leadId = wonEvent.id;
  const statusId = wonEvent.status_id ?? null;

  // Conversation pode não existir ainda (lead que avançou sem nunca trocar
  // mensagem). Nesse caso, criamos um stub e marcamos — o painel saberá
  // mostrar "convertido sem conversa" pra você revisar.
  const conv = await prisma.conversation.upsert({
    where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
    update: {
      // Não sobrescreve convertedAt se já foi marcada antes (idempotência).
      convertedAt: { set: new Date() },
      convertedStatusId: statusId,
    },
    create: {
      unitId: unit.id,
      leadId: String(leadId),
      channel: 'kommo',
      convertedAt: new Date(),
      convertedStatusId: statusId,
    },
  });

  logger.info(
    { unitId: unit.id, leadId, statusId, conversationId: conv.id },
    'webhook: conversão detectada',
  );

  // Dispara juiz em background — não bloqueia resposta do webhook.
  void judgeConversation({ conversationId: conv.id, unit }).catch((err) => {
    logger.error({ err, conversationId: conv.id }, 'webhook: judge falhou em background');
  });

  return { converted: true, leadId, statusId };
}

// ---------------------------------------------------------------------------
// Handler principal — POST /api/webhooks/[:unitSlug/]kommo
// ---------------------------------------------------------------------------

export async function handleKommoWebhook(req: Request, res: Response): Promise<void> {
  const requestStart = performance.now();

  const unit = await resolveUnit(req);
  if (!unit) {
    res.status(404).json({ ok: false, error: 'unit_not_found' });
    return;
  }

  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten() }, 'webhook inválido');
    res.status(400).json({ ok: false, error: 'invalid payload' });
    return;
  }

  // Detecta conversão ANTES de tudo. Eventos de mudança de status podem
  // chegar isoladamente (sem mensagem). Se for esse o caso e a etapa for
  // de "Ganho", marcamos e respondemos — não há nada pro agente fazer.
  const conversion = await detectAndHandleConversion(unit, parsed.data);
  const onlyStatusEvent =
    !parsed.data.message?.add?.length &&
    !parsed.data.text &&
    (parsed.data.leads?.status?.length ?? 0) > 0 &&
    !parsed.data.leads?.add?.length;
  if (conversion.converted && onlyStatusEvent) {
    res.status(200).json({
      ok: true,
      converted: true,
      leadId: conversion.leadId,
      statusId: conversion.statusId,
      unit: unit.slug,
    });
    return;
  }

  const leadId = extractLeadId(parsed.data);
  if (!leadId) {
    logger.warn({ body: req.body }, 'webhook sem leadId');
    res.status(400).json({ ok: false, error: 'leadId not found in payload' });
    return;
  }

  const ctx = extractContext(parsed.data, leadId);

  const trace = await prisma.executionTrace.create({
    data: {
      unitId: unit.id,
      threadId: buildThreadId(unit.slug, leadId),
      leadId: String(leadId),
      channel: ctx.isChatMessage ? 'kommo_chat' : 'kommo',
      input: req.body as object,
      status: 'RUNNING',
    },
  });

  const recorder = new TraceRecorder(trace.id, unit.id);
  await recorder.step({
    kind: 'WEBHOOK_RECEIVED',
    title: ctx.isChatMessage
      ? `Mensagem de ${ctx.contactName ?? 'paciente'} (Lead ${leadId}): "${ctx.humanMessage.slice(0, 80)}"`
      : `Payload recebido do Kommo (Lead ID ${leadId})`,
    payload: req.body as object,
  });

  // Conversa: se for mensagem de chat, registra o "user" turn.
  if (ctx.isChatMessage) {
    const conv = await upsertConversation({
      unitId: unit.id,
      leadId: String(leadId),
      contactName: ctx.contactName,
      channel: 'kommo_chat',
    });
    await addMessage({
      conversationId: conv.id,
      traceId: trace.id,
      role: 'user',
      content: ctx.humanMessage,
      meta: { chatId: ctx.chatId, talkId: ctx.talkId, contactId: ctx.contactId },
    });
  }

  res.status(200).json({ ok: true, traceId: trace.id, unit: unit.slug });

  void processAgent({
    unit,
    leadId,
    traceId: trace.id,
    humanMessage: ctx.humanMessage,
    chatId: ctx.chatId,
    talkId: ctx.talkId,
    contactId: ctx.contactId,
    isChatMessage: ctx.isChatMessage,
    requestStart,
  }).catch((err) => {
    logger.error({ err, traceId: trace.id }, 'erro fatal no background do agente');
  });
}

// ---------------------------------------------------------------------------
// Processamento assíncrono.
// ---------------------------------------------------------------------------

async function processAgent(args: {
  unit: Unit;
  leadId: number;
  traceId: string;
  humanMessage: string;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  isChatMessage: boolean;
  requestStart: number;
}): Promise<void> {
  const { unit, leadId, traceId, humanMessage, chatId, talkId, contactId, isChatMessage, requestStart } = args;
  const recorder = new TraceRecorder(traceId, unit.id);
  await syncRecorderSequence(recorder, traceId);

  try {
    const graph = await buildAgentGraph(recorder, unit);
    const threadId = buildThreadId(unit.slug, leadId);

    const result = await graph.invoke(
      {
        leadId,
        traceId,
        messages: [new HumanMessage(humanMessage)],
      },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 10,
      },
    );

    const reply = (result.decision ?? '').toString().trim();

    if (isChatMessage && reply) {
      const sendStart = performance.now();
      try {
        const kommo = createKommoClient(unit);
        const sendResult = await kommo.sendChatReply({
          leadId,
          chatId,
          talkId,
          contactId,
          text: reply,
        });
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Resposta entregue ao paciente via ${sendResult.via}`,
          payload: { reply, via: sendResult.via, detail: sendResult.detail },
          latencyMs: Math.round(performance.now() - sendStart),
        });
        // Registra turno do assistente na conversa.
        const conv = await upsertConversation({
          unitId: unit.id,
          leadId: String(leadId),
          channel: 'kommo_chat',
        });
        await addMessage({
          conversationId: conv.id,
          traceId,
          role: 'assistant',
          content: reply,
          meta: { via: sendResult.via },
        });
      } catch (sendErr) {
        const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao enviar resposta ao Kommo: ${msg}`,
          payload: { reply, error: msg },
          latencyMs: Math.round(performance.now() - sendStart),
        });
        logger.error({ err: sendErr, traceId, leadId }, 'falha enviando resposta ao Kommo');
      }
    }

    const totalLatency = Math.round(performance.now() - requestStart);

    await recorder.step({
      kind: 'COMPLETED',
      title: `Execução concluída em ${totalLatency}ms`,
      latencyMs: totalLatency,
    });

    await recorder.finalize({
      status: 'SUCCESS',
      latencyMs: totalLatency,
      iaDecision: result.decision ?? null,
    });

    logger.info({ traceId, leadId, ms: totalLatency, unit: unit.slug }, 'agente concluído');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const totalLatency = Math.round(performance.now() - requestStart);
    await recorder.step({
      kind: 'ERROR',
      title: `Falha no agente: ${msg}`,
      payload: { error: msg },
      latencyMs: totalLatency,
    });
    await recorder.finalize({
      status: 'FAILED',
      latencyMs: totalLatency,
      errorMessage: msg,
    });
    logger.error({ err, traceId, leadId, unit: unit.slug }, 'agente falhou');
  }
}
