// ============================================================================
// meta.controller.ts — Webhook da Meta WhatsApp Cloud API (multi-tenant).
//
// LÓGICA DE ENGENHARIA
// --------------------
// A Meta exige DOIS handlers no mesmo path:
//   GET  /webhooks/{slug}/meta?hub.mode=subscribe&hub.verify_token=X
//        → respondemos com challenge se token bater. Handshake one-time.
//   POST /webhooks/{slug}/meta
//        → eventos (mensagens recebidas, status, etc).
//
// IMPORTANTE: a Meta exige resposta 200 em ≤ 5s no POST. Não dá para esperar
// a LLM responder — fire-and-forget igual ao Kommo CRM.
//
// SIGNATURE VALIDATION
// --------------------
// O POST da Meta vem assinado em `x-hub-signature-256` calculado sobre o
// RAW body com HMAC-SHA256 + APP_SECRET da unidade. Para isso o express
// precisa preservar o raw body — feito no server.ts via opção `verify`
// do express.json para esta rota específica.
// ============================================================================

import type { Request, Response } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildAgentGraph, buildThreadId } from '../agent/graph.js';
import { TraceRecorder, syncRecorderSequence } from '../agent/trace-recorder.js';
import { findUnitBySlug } from '../services/units.service.js';
import { addMessage, upsertConversation } from '../services/conversations.service.js';
import { MetaService, type MetaInboundMessage } from '../services/meta.service.js';

// ---------------------------------------------------------------------------
// GET — handshake de verificação.
// ---------------------------------------------------------------------------

export async function handleMetaVerify(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.unitSlug ?? '');
  if (!slug) {
    res.status(400).send('missing_unit_slug');
    return;
  }
  const unit = await findUnitBySlug(slug);
  if (!unit) {
    res.status(404).send('unit_not_found');
    return;
  }

  const result = MetaService.verifyWebhook(unit, {
    mode: req.query['hub.mode'] as string | undefined,
    token: req.query['hub.verify_token'] as string | undefined,
    challenge: req.query['hub.challenge'] as string | undefined,
  });

  if (!result.ok) {
    logger.warn({ slug, reason: result.reason }, 'meta verify falhou');
    res.status(403).send(result.reason ?? 'forbidden');
    return;
  }
  res.status(200).send(result.challenge ?? '');
}

// ---------------------------------------------------------------------------
// POST — eventos de mensagem.
// ---------------------------------------------------------------------------

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export async function handleMetaWebhook(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.unitSlug ?? '');
  if (!slug) {
    res.status(400).json({ ok: false, error: 'missing_unit_slug' });
    return;
  }
  const unit = await findUnitBySlug(slug);
  if (!unit) {
    res.status(404).json({ ok: false, error: 'unit_not_found' });
    return;
  }

  // Validação de signature (sha256 hmac do raw body com app_secret).
  const rawBody = (req as RawBodyRequest).rawBody;
  if (rawBody && unit.metaAppSecret) {
    const sigHeader = req.header('x-hub-signature-256');
    const valid = MetaService.validateSignature(rawBody, sigHeader, unit.metaAppSecret);
    if (!valid) {
      logger.warn({ slug }, 'meta signature inválida');
      res.status(401).json({ ok: false, error: 'invalid_signature' });
      return;
    }
  }

  const inbound = MetaService.parseInbound(req.body);

  // ACK rápido — Meta exige 200 em ≤5s.
  res.status(200).json({ ok: true, received: inbound.length });

  if (inbound.length === 0) {
    logger.debug({ slug }, 'meta webhook sem mensagens (status update?)');
    return;
  }

  // Processa cada mensagem em background.
  for (const msg of inbound) {
    void processMetaMessage(unit, msg, performance.now()).catch((err) => {
      logger.error({ err, slug, msgId: msg.messageId }, 'erro processando mensagem Meta');
    });
  }
}

// ---------------------------------------------------------------------------
// Processamento por mensagem.
// ---------------------------------------------------------------------------

async function processMetaMessage(
  unit: Unit,
  msg: MetaInboundMessage,
  requestStart: number,
): Promise<void> {
  if (!msg.text) {
    logger.debug({ msgId: msg.messageId, type: msg.type }, 'meta: mensagem sem texto, ignorando');
    return;
  }

  // No fluxo Meta puro, "leadId" passa a ser o telefone do contato (E.164).
  // Não temos lead numérico do Kommo aqui — usamos o `from` como chave.
  const leadId = msg.from;

  const trace = await prisma.executionTrace.create({
    data: {
      unitId: unit.id,
      threadId: buildThreadId(unit.slug, leadId),
      leadId,
      channel: 'meta',
      input: msg as unknown as object,
      status: 'RUNNING',
    },
  });

  const recorder = new TraceRecorder(trace.id, unit.id);
  await recorder.step({
    kind: 'WEBHOOK_RECEIVED',
    title: `WhatsApp ${msg.contactName ?? msg.from}: "${msg.text.slice(0, 80)}"`,
    payload: msg as unknown as object,
  });

  // Conversa: turno do paciente.
  const conv = await upsertConversation({
    unitId: unit.id,
    leadId,
    contactName: msg.contactName,
    phone: msg.from,
    channel: 'meta',
  });
  await addMessage({
    conversationId: conv.id,
    traceId: trace.id,
    role: 'user',
    content: msg.text,
    meta: { messageId: msg.messageId, type: msg.type },
  });

  await syncRecorderSequence(recorder, trace.id);

  try {
    const graph = await buildAgentGraph(recorder, unit);
    const threadId = buildThreadId(unit.slug, leadId);

    const result = await graph.invoke(
      {
        leadId: 0, // numérico não se aplica no canal Meta puro
        traceId: trace.id,
        messages: [new HumanMessage(msg.text)],
      },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 6,
      },
    );

    const reply = (result.decision ?? '').toString().trim();
    if (reply) {
      const sendStart = performance.now();
      const sendResult = await MetaService.sendText(unit, msg.from, reply);
      if (sendResult.ok) {
        await recorder.step({
          kind: 'META_ACTION',
          title: `Resposta enviada via Meta (msg ${sendResult.messageId})`,
          payload: { to: msg.from, reply, messageId: sendResult.messageId },
          latencyMs: Math.round(performance.now() - sendStart),
        });
        await addMessage({
          conversationId: conv.id,
          traceId: trace.id,
          role: 'assistant',
          content: reply,
          meta: { via: 'meta', messageId: sendResult.messageId },
        });
      } else {
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao enviar via Meta: ${sendResult.error}`,
          payload: { to: msg.from, error: sendResult.error },
          latencyMs: Math.round(performance.now() - sendStart),
        });
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
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const totalLatency = Math.round(performance.now() - requestStart);
    await recorder.step({
      kind: 'ERROR',
      title: `Falha no agente: ${errMsg}`,
      payload: { error: errMsg },
      latencyMs: totalLatency,
    });
    await recorder.finalize({
      status: 'FAILED',
      latencyMs: totalLatency,
      errorMessage: errMsg,
    });
    logger.error({ err, traceId: trace.id, unit: unit.slug }, 'meta: agente falhou');
  }
}
