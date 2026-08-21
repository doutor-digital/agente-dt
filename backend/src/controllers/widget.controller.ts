import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildThreadId } from '../agent/graph.js';
import { TraceRecorder } from '../agent/trace-recorder.js';
import { createKommoClient } from '../services/kommo.service.js';
import { findUnitBySlug } from '../services/units.service.js';
import { addMessage, upsertConversation } from '../services/conversations.service.js';
import { claimMessageId } from '../lib/dedup-cache.js';
import {
  recordWidgetRequest,
  recordWidgetDelivery,
  type WidgetJwtStatus,
} from '../lib/widget-connection-monitor.js';
import { processAgent, type AgentDeliverFn } from './webhook.controller.js';
import type { Unit } from '@prisma/client';

const widgetBodySchema = z.object({
  token: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  return_url: z.string().url(),
});

function verifyWidgetToken(
  token: string | undefined,
  secret: string | null,
  unitSlug: string,
): WidgetJwtStatus {
  if (!secret) {
    logger.warn({ unit: unitSlug }, 'widget: kommoWidgetSecret não configurado — validação de JWT pulada (permissivo)');
    return 'no_secret';
  }
  if (!token) {
    logger.warn({ unit: unitSlug }, 'widget: request sem token JWT (secret existe) — seguindo (permissivo no piloto)');
    return 'no_token';
  }
  try {
    jwt.verify(token, secret, { algorithms: ['HS256'] });
    return 'valid';
  } catch (err) {
    logger.warn(
      { unit: unitSlug, err },
      'widget: JWT inválido — seguindo mesmo assim (permissivo no piloto); endurecer pra 401 após validar a assinatura do Kommo',
    );
    return 'invalid';
  }
}

export async function handleWidgetRequest(req: Request, res: Response): Promise<void> {
  const requestStart = performance.now();

  const slug = req.params.unitSlug ? String(req.params.unitSlug) : '';
  const unit = slug ? await findUnitBySlug(slug) : null;
  if (!unit) {
    res.status(404).json({ ok: false, error: 'unit_not_found' });
    return;
  }

  if (!unit.kommoWidgetReplyEnabled) {
    logger.warn({ unit: unit.slug }, 'widget request recebido mas modo widget está DESLIGADO nesta unidade — ignorando');
    res.status(200).json({ ok: true, skipped: 'widget_mode_disabled', unit: unit.slug });
    return;
  }

  const parsed = widgetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten(), unit: unit.slug }, 'widget request inválido');
    res.status(400).json({ ok: false, error: 'invalid payload' });
    return;
  }
  const { token, data, return_url: returnUrl } = parsed.data;

  const jwtStatus = verifyWidgetToken(token, unit.kommoWidgetSecret, unit.slug);

  const message = typeof data?.message === 'string' ? data.message : String(data?.message ?? '');
  const leadId = Number(data?.lead);
  recordWidgetRequest(unit.id, {
    jwt: jwtStatus,
    leadId: leadId && !Number.isNaN(leadId) ? leadId : null,
  });
  if (!leadId || Number.isNaN(leadId)) {
    logger.warn({ unit: unit.slug, lead: data?.lead }, 'widget request sem leadId válido em data.lead');
    res.status(400).json({ ok: false, error: 'lead not found in data' });
    return;
  }

  res.status(200).json({ ok: true, unit: unit.slug });

  if (!message.trim()) {
    try {
      await createKommoClient(unit).continueSalesbotWidget(returnUrl, { text: '' });
      recordWidgetDelivery(unit.id, { ok: true });
    } catch (err) {
      recordWidgetDelivery(unit.id, { ok: false, error: err instanceof Error ? err.message : String(err) });
      logger.warn({ err, unit: unit.slug, leadId }, 'widget: falha ao finalizar bot em mensagem vazia');
    }
    return;
  }

  void processWidget({ unit, leadId, message, returnUrl, requestStart }).catch((err) => {
    logger.error({ err, unit: unit.slug, leadId }, 'widget: erro fatal no processamento async');
  });
}

async function processWidget(args: {
  unit: Unit;
  leadId: number;
  message: string;
  returnUrl: string;
  requestStart: number;
}): Promise<void> {
  const { unit, leadId, message, returnUrl, requestStart } = args;

  if (!claimMessageId('widget', returnUrl)) {
    logger.info({ unit: unit.slug, leadId }, 'widget request duplicado (mesmo return_url) — ignorando reprocessamento');
    return;
  }

  const trace = await prisma.executionTrace.create({
    data: {
      unitId: unit.id,
      threadId: buildThreadId(unit.slug, leadId),
      leadId: String(leadId),
      channel: 'kommo_chat',
      input: { message, return_url: returnUrl, via: 'widget_request' } as object,
      status: 'RUNNING',
    },
  });

  const recorder = new TraceRecorder(trace.id, unit.id);
  await recorder.step({
    kind: 'WEBHOOK_RECEIVED',
    title: `Widget request (Lead ${leadId}): "${message.slice(0, 80)}"`,
    payload: { message, return_url: returnUrl, via: 'widget_request' },
  });

  const conv = await upsertConversation({
    unitId: unit.id,
    leadId: String(leadId),
    channel: 'kommo_chat',
  });
  await addMessage({
    conversationId: conv.id,
    traceId: trace.id,
    role: 'user',
    content: message,
    meta: { via: 'widget_request' },
  });

  const kommo = createKommoClient(unit);
  const deliver: AgentDeliverFn = async (text) => {
    try {
      const detail = await kommo.continueSalesbotWidget(returnUrl, { text, recorder });
      recordWidgetDelivery(unit.id, { ok: true });
      return { via: detail.via, detail };
    } catch (e) {
      recordWidgetDelivery(unit.id, { ok: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };

  await processAgent({
    unit,
    leadId,
    traceId: trace.id,
    humanMessage: message,
    audioUrl: null,
    imageUrl: null,
    chatId: null,
    talkId: null,
    contactId: null,
    isChatMessage: true,
    requestStart,
    deliver,
  });
}
