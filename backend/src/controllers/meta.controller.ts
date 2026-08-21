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
import { claimMessageId } from '../lib/dedup-cache.js';

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

  res.status(200).json({ ok: true, received: inbound.length });

  if (inbound.length === 0) {
    logger.debug({ slug }, 'meta webhook sem mensagens (status update?)');
    return;
  }

  for (const msg of inbound) {
    if (msg.messageId && !claimMessageId('meta', msg.messageId)) {
      logger.info(
        { slug, msgId: msg.messageId },
        'meta webhook duplicado (retry) — ignorando',
      );
      continue;
    }
    void processMetaMessage(unit, msg, performance.now()).catch((err) => {
      logger.error({ err, slug, msgId: msg.messageId }, 'erro processando mensagem Meta');
    });
  }
}

async function processMetaMessage(
  unit: Unit,
  msg: MetaInboundMessage,
  requestStart: number,
): Promise<void> {
  if (!msg.text) {
    logger.debug({ msgId: msg.messageId, type: msg.type }, 'meta: mensagem sem texto, ignorando');
    return;
  }

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
        leadId: 0,
        traceId: trace.id,
        messages: [new HumanMessage(msg.text)],
      },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 24,
      },
    );

    const reply = (result.decision ?? '').toString().trim();
    if (reply) {
      const delaySec = Math.max(0, Math.min(unit.personaResponseDelaySec ?? 0, 30));
      if (delaySec > 0) {
        await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
      }
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
