// ============================================================================
// salesbot.controller.ts — Webhook do Kommo Salesbot (chat conversacional).
//
// LÓGICA DE ENGENHARIA
// --------------------
// O webhook genérico do Kommo (handleKommoWebhook) só carrega eventos de CRM
// (lead criado/alterado) — não inclui texto de mensagem WhatsApp. Para chat
// real, o Kommo usa o Salesbot, que tem comportamento DIFERENTE:
//
//   1. Salesbot envia POST com o texto da mensagem incluído no payload.
//   2. Salesbot AGUARDA a resposta HTTP (timeout ~60s).
//   3. A resposta HTTP é parseada pelo Salesbot — o que estiver em
//      `reply` (ou outro campo configurável) é enviado de volta ao paciente.
//
// Por isso este controller é SÍNCRONO (não fire-and-forget como o de CRM):
// o Salesbot fica esperando o JSON com a resposta da Sofia. Se demorar
// demais, o bot timeouta e a conversa quebra.
//
// CONTRATO DO PAYLOAD
// -------------------
// O Salesbot do Kommo deixa VOCÊ MONTAR o JSON do webhook. A gente define
// um schema permissivo que aceita variações comuns. Os campos esperados:
//
//   {
//     "message":     "texto que o paciente mandou",      // OBRIGATÓRIO
//     "lead_id":     "12345",                            // OBRIGATÓRIO (string ou num)
//     "contact_id":  "67890",                            // opcional
//     "contact_name":"João",                             // opcional
//     "phone":       "5563999999999",                    // opcional
//     "current_time":"2026-05-12T14:00:00Z"              // opcional (pro [HORA:] da Sofia)
//   }
//
// RESPOSTA
// --------
//   { "ok": true, "reply": "texto que a Sofia respondeu", "traceId": "..." }
//
// No Salesbot, configurar a próxima ação como "Enviar mensagem" usando a
// variável `{{webhook.reply}}` (ou o nome que o Salesbot der ao campo).
// ============================================================================

import type { Request, Response } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildAgentGraph } from '../agent/graph.js';
import { TraceRecorder } from '../agent/trace-recorder.js';

// ---------------------------------------------------------------------------
// Schema permissivo — aceita string ou número para IDs, e variantes de campo
// (alguns Salesbots usam "text" em vez de "message", etc.).
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

function extractMessage(p: Payload): string | null {
  return (p.message || p.text || '').trim() || null;
}

function extractLeadId(p: Payload): string | null {
  return p.lead_id || p.leadId || null;
}

function extractContactName(p: Payload): string | null {
  return p.contact_name || p.contactName || null;
}

// ---------------------------------------------------------------------------
// Hora atual no fuso de Araguaína (UTC-3, sem horário de verão) para a tag
// [HORA:] que a Sofia espera no prompt (saudação por turno).
// ---------------------------------------------------------------------------

function currentTimeTag(): string {
  const utc = new Date();
  const araguaina = new Date(utc.getTime() - 3 * 60 * 60 * 1000);
  const h = String(araguaina.getUTCHours()).padStart(2, '0');
  const m = String(araguaina.getUTCMinutes()).padStart(2, '0');
  return `[HORA: ${h}:${m}]`;
}

// ---------------------------------------------------------------------------
// Handler principal — SÍNCRONO (Salesbot espera).
// ---------------------------------------------------------------------------

export async function handleSalesbotWebhook(req: Request, res: Response): Promise<void> {
  const requestStart = performance.now();

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten(), body: req.body }, 'salesbot payload inválido');
    res.status(400).json({ ok: false, error: 'invalid_payload', reply: 'Erro técnico, tente em instantes.' });
    return;
  }

  const message = extractMessage(parsed.data);
  const leadId = extractLeadId(parsed.data);
  const contactName = extractContactName(parsed.data);

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

  // Cria o trace ANTES de chamar a Sofia — assim o dashboard vê a execução
  // mesmo se a Sofia demorar.
  const trace = await prisma.executionTrace.create({
    data: {
      threadId: `lead-${leadId}`,
      leadId,
      input: req.body as object,
      status: 'RUNNING',
    },
  });

  const recorder = new TraceRecorder(trace.id);
  await recorder.step({
    kind: 'WEBHOOK_RECEIVED',
    title: contactName
      ? `Mensagem de ${contactName} (Lead ${leadId})`
      : `Mensagem do Lead ${leadId}`,
    payload: req.body as object,
  });

  // Mensagem final entregue à Sofia: prefixo [HORA: HH:MM] que o prompt dela
  // espera pra escolher a saudação, depois o texto do paciente.
  const humanMessage = `${currentTimeTag()} ${message}`;

  try {
    const graph = await buildAgentGraph(recorder);
    const threadId = `lead-${leadId}`;

    const result = await graph.invoke(
      {
        leadId: Number(leadId),
        traceId: trace.id,
        messages: [new HumanMessage(humanMessage)],
      },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 6, // chat — não esperamos loop longo de tools
      },
    );

    const reply = (result.decision ?? '').trim() || 'Recebi sua mensagem, tô só verificando com a equipe um instante 🙏';
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

    res.json({ ok: true, reply, traceId: trace.id });
    logger.info({ traceId: trace.id, leadId, ms: totalLatency }, 'salesbot concluído');
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
    logger.error({ err, traceId: trace.id, leadId }, 'salesbot falhou');

    // Mesmo em erro, devolvemos um `reply` pro Salesbot mandar algo simpático
    // ao paciente — não dá pra deixar ele no vácuo.
    res.status(200).json({
      ok: false,
      reply: 'Recebi sua mensagem 💚 Vou pedir pra Maria Eduarda te atender de manhã, tá?',
      traceId: trace.id,
      error: msg,
    });
  }
}
