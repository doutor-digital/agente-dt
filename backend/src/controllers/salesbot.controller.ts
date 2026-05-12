// ============================================================================
// salesbot.controller.ts — Webhook do Kommo Salesbot (multi-tenant).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Diferente do webhook genérico do Kommo (handleKommoWebhook), o Salesbot
// é SÍNCRONO: ele aguarda a resposta HTTP (timeout ~60s) e o que estiver
// no campo `reply` é enviado ao paciente como mensagem.
//
// MULTI-TENANT
// ------------
// A rota é /api/webhooks/:unitSlug/salesbot. Caímos pra default unit se
// nenhum slug — retrocompat com /api/webhooks/salesbot.
// ============================================================================

import type { Request, Response } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildAgentGraph, buildThreadId } from '../agent/graph.js';
import { TraceRecorder } from '../agent/trace-recorder.js';
import { findUnitBySlug, ensureDefaultUnit } from '../services/units.service.js';
import { addMessage, upsertConversation } from '../services/conversations.service.js';

// ---------------------------------------------------------------------------
// Schema permissivo — aceita string ou número para IDs.
// ---------------------------------------------------------------------------

const payloadSchema = z
  .object({
    message: z.string().optional(),
    text: z.string().optional(),
    lead_id: z.coerce.string().optional(),
    leadId: z.coerce.string().optional(),
    contact_id: z.coerce.string().optional(),
    contactId: z.coerce.string().optional(),
    contact_name: z.string().optional(),
    contactName: z.string().optional(),
    phone: z.string().optional(),
    current_time: z.string().optional(),
  })
  .passthrough();

type Payload = z.infer<typeof payloadSchema>;

const extractMessage = (p: Payload) => (p.message || p.text || '').trim() || null;
const extractLeadId = (p: Payload) => p.lead_id || p.leadId || null;
const extractContactName = (p: Payload) => p.contact_name || p.contactName || null;

// Hora atual no fuso de Araguaína (UTC-3, sem horário de verão).
function currentTimeTag(): string {
  const utc = new Date();
  const araguaina = new Date(utc.getTime() - 3 * 60 * 60 * 1000);
  const h = String(araguaina.getUTCHours()).padStart(2, '0');
  const m = String(araguaina.getUTCMinutes()).padStart(2, '0');
  return `[HORA: ${h}:${m}]`;
}

async function resolveUnit(req: Request): Promise<Unit | null> {
  const slug = req.params.unitSlug ? String(req.params.unitSlug) : '';
  if (slug) return findUnitBySlug(slug);
  return ensureDefaultUnit();
}

// ---------------------------------------------------------------------------
// Handler principal — POST /api/webhooks/[:unitSlug/]salesbot — SÍNCRONO.
// ---------------------------------------------------------------------------

export async function handleSalesbotWebhook(req: Request, res: Response): Promise<void> {
  const requestStart = performance.now();

  const unit = await resolveUnit(req);
  if (!unit) {
    res.status(404).json({ ok: false, error: 'unit_not_found', reply: 'Erro técnico, tente em instantes.' });
    return;
  }

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten(), body: req.body }, 'salesbot payload inválido');
    res.status(400).json({ ok: false, error: 'invalid_payload', reply: 'Erro técnico, tente em instantes.' });
    return;
  }

  const message = extractMessage(parsed.data);
  const leadId = extractLeadId(parsed.data);
  const contactName = extractContactName(parsed.data);
  const phone = parsed.data.phone ?? null;

  if (!message || !leadId) {
    logger.warn({ body: req.body }, 'salesbot sem message/leadId');
    res.status(400).json({
      ok: false,
      error: 'missing_fields',
      reply: 'Erro técnico, tente em instantes.',
      hint: 'payload precisa de "message" e "lead_id"',
    });
    return;
  }

  const trace = await prisma.executionTrace.create({
    data: {
      unitId: unit.id,
      threadId: buildThreadId(unit.slug, leadId),
      leadId,
      channel: 'salesbot',
      input: req.body as object,
      status: 'RUNNING',
    },
  });

  const recorder = new TraceRecorder(trace.id, unit.id);
  await recorder.step({
    kind: 'WEBHOOK_RECEIVED',
    title: contactName ? `Mensagem de ${contactName} (Lead ${leadId})` : `Mensagem do Lead ${leadId}`,
    payload: req.body as object,
  });

  // Registra turno do paciente na conversa.
  const conv = await upsertConversation({
    unitId: unit.id,
    leadId,
    contactName,
    phone,
    channel: 'salesbot',
  });
  await addMessage({
    conversationId: conv.id,
    traceId: trace.id,
    role: 'user',
    content: message,
  });

  const humanMessage = `${currentTimeTag()} ${message}`;

  try {
    const graph = await buildAgentGraph(recorder, unit);
    const threadId = buildThreadId(unit.slug, leadId);

    const result = await graph.invoke(
      {
        leadId: Number(leadId),
        traceId: trace.id,
        messages: [new HumanMessage(humanMessage)],
      },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 6,
      },
    );

    const reply =
      (result.decision ?? '').trim() ||
      'Recebi sua mensagem, tô só verificando com a equipe um instante 🙏';
    const totalLatency = Math.round(performance.now() - requestStart);

    await recorder.step({
      kind: 'COMPLETED',
      title: `Resposta gerada em ${totalLatency}ms`,
      latencyMs: totalLatency,
      payload: { reply },
    });
    await recorder.finalize({
      status: 'SUCCESS',
      latencyMs: totalLatency,
      iaDecision: reply,
    });

    // Turno do assistente na conversa.
    await addMessage({
      conversationId: conv.id,
      traceId: trace.id,
      role: 'assistant',
      content: reply,
      meta: { via: 'salesbot' },
    });

    res.json({ ok: true, reply, traceId: trace.id, unit: unit.slug });
    logger.info({ traceId: trace.id, leadId, ms: totalLatency, unit: unit.slug }, 'salesbot concluído');
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
    logger.error({ err, traceId: trace.id, leadId, unit: unit.slug }, 'salesbot falhou');

    res.status(200).json({
      ok: false,
      reply: 'Recebi sua mensagem 💚 Vou pedir pra Maria Eduarda te atender de manhã, tá?',
      traceId: trace.id,
      error: msg,
    });
  }
}
