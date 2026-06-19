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
import { createKommoClient, isLeadPaused } from '../services/kommo.service.js';
import { checkBusinessHours } from '../agent/prompt-composer.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { synthesizeSpeech } from '../services/tts.service.js';
import { putAudio } from '../services/audio-store.js';
import { env } from '../lib/env.js';
import { findUnitBySlug, ensureDefaultUnit } from '../services/units.service.js';
import { addMessage, upsertConversation } from '../services/conversations.service.js';
import { judgeConversation } from '../services/conversation-judge.service.js';
import { claimMessageId } from '../lib/dedup-cache.js';
import { enforceReplyGap } from '../lib/reply-gate.js';
import { trackPendingReply, confirmDelivery } from '../lib/stale-reply-monitor.js';
import { scheduleAgentRun } from '../lib/agent-coalescer.js';
import { getPausedStagesGlobalSet } from '../services/actions.service.js';
import { scheduleLeadMemoryUpdate } from '../services/lead-memory.service.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema do payload do Kommo (CRM events + chat events).
// ---------------------------------------------------------------------------

// Attachment do Kommo — vem quando o cliente manda áudio, imagem, doc.
// Kommo usa nomes variados conforme versão: `attachment` (singular) ou
// `attachments` (plural). Schema permissivo aceita ambos.
const attachmentSchema = z
  .object({
    type: z.string().optional(),     // "voice" | "audio" | "image" | "file" | ...
    link: z.string().url().optional(),
    file_name: z.string().optional(),
    name: z.string().optional(),
  })
  .partial();

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
  attachment: attachmentSchema.optional(),
  attachments: z.array(attachmentSchema).optional(),
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
  // Aceita mensagens com texto OU com áudio anexo (vamos transcrever depois).
  const incoming = messages.find(
    (m) => (m.type ?? 'incoming') === 'incoming' && (m.text || hasAudioAttachment(m)),
  );
  return incoming ?? null;
}

// Mensagens OUTGOING do webhook — o Kommo nos avisa quando o Salesbot ENTREGA
// a resposta. Não acionam o agente; servem só pra confirmar entrega no monitor
// de "resposta parada".
function getOutgoingMessages(parsed: ParsedWebhook): MessageEvent[] {
  return (parsed.message?.add ?? []).filter((m) => (m.type ?? 'incoming') === 'outgoing');
}

const AUDIO_TYPES = new Set(['voice', 'audio']);
const AUDIO_EXT_RE = /\.(ogg|opus|mp3|m4a|wav|aac)$/i;

function hasAudioAttachment(msg: MessageEvent): boolean {
  return !!getAudioUrl(msg);
}

/** Retorna o URL do áudio da mensagem, ou null se não houver. */
function getAudioUrl(msg: MessageEvent): string | null {
  const all = [
    ...(msg.attachment ? [msg.attachment] : []),
    ...(msg.attachments ?? []),
  ];
  for (const a of all) {
    if (!a.link) continue;
    const type = (a.type ?? '').toLowerCase();
    if (AUDIO_TYPES.has(type)) return a.link;
    const name = (a.file_name ?? a.name ?? a.link).toLowerCase();
    if (AUDIO_EXT_RE.test(name)) return a.link;
  }
  return null;
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
  audioUrl: string | null;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  contactName: string | null;
  isChatMessage: boolean;
}

function extractContext(parsed: ParsedWebhook, leadId: number): ExtractedContext {
  const msg = getIncomingMessage(parsed);
  if (msg) {
    return {
      humanMessage: msg.text ?? '',
      audioUrl: getAudioUrl(msg),
      chatId: msg.chat_id ?? null,
      talkId: msg.talk_id ?? null,
      contactId: msg.contact_id ?? null,
      contactName: msg.author?.name ?? null,
      isChatMessage: true,
    };
  }
  return {
    humanMessage: parsed.text ?? `Webhook recebido para lead ${leadId}. Analise e tome a melhor ação.`,
    audioUrl: null,
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

// Quando a Unit tem Meta WhatsApp Cloud API configurada, ela é o canal
// primário do agente. O webhook Kommo continua útil pra detectar conversão
// (status change), mas não deve disparar o agente nem gravar mensagens —
// quem cuida disso é o webhook Meta. Evita resposta duplicada.
function isMetaPrimary(unit: Unit): boolean {
  return !!unit.metaPhoneNumberId && !!unit.metaAccessToken;
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

  // Confirmação de entrega + detecção de takeover humano. O Kommo manda webhook
  // OUTGOING tanto quando o Salesbot entrega a NOSSA resposta quanto quando um
  // atendente responde na mão. confirmDelivery() devolve true se a outgoing
  // casou com uma resposta nossa pendente (= foi a IA). Uma outgoing que NÃO é
  // nossa e cujo autor é um usuário da conta (author.type="user") significa que
  // um humano assumiu — o cliente vem como author.type="external".
  let humanTakeoverLeadId: number | null = null;
  for (const out of getOutgoingMessages(parsed.data)) {
    if (!out.entity_id) continue;
    const wasOurReply = confirmDelivery({ unitId: unit.id, leadId: out.entity_id, text: out.text });
    if (!wasOurReply && (out.author?.type ?? '').toLowerCase() === 'user') {
      humanTakeoverLeadId = out.entity_id;
    }
  }

  // Auto-pausa por takeover humano: atendente respondeu manualmente pelo Kommo →
  // marcamos "IA Pausada" pra IA não atropelar a conversa. Destrava só manual
  // (operador desmarca o campo). A TRAVA 2 (isLeadPaused) barra as próximas
  // mensagens do cliente. Requer kommoPausedFieldId configurado.
  if (humanTakeoverLeadId && unit.kommoPausedFieldId) {
    try {
      const kommo = createKommoClient(unit);
      // Evita PATCH redundante a cada mensagem do atendente.
      if (!(await kommo.isLeadFieldChecked(humanTakeoverLeadId, unit.kommoPausedFieldId))) {
        await kommo.setLeadFieldFlag(humanTakeoverLeadId, unit.kommoPausedFieldId, true);
        logger.info(
          { leadId: humanTakeoverLeadId, unit: unit.slug },
          'IA auto-pausada: atendente humano assumiu a conversa',
        );
      }
    } catch (err) {
      logger.warn(
        { err, leadId: humanTakeoverLeadId, unit: unit.slug },
        'falha ao auto-pausar por takeover humano — seguindo',
      );
    }
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

  if (isMetaPrimary(unit)) {
    logger.debug(
      { unit: unit.slug },
      'kommo webhook: Meta é canal primário, ignorando gatilho do agente',
    );
    res.status(200).json({
      ok: true,
      skipped: 'meta_is_primary',
      converted: conversion.converted,
      unit: unit.slug,
    });
    return;
  }

  // MODO WIDGET: quando ligado, a geração E a entrega da resposta acontecem no
  // endpoint /widget (disparado pelo passo "Widget" do Salesbot via
  // widget_request). O webhook /kommo segue útil pra eventos de status/conversão
  // (tratados acima), mas NÃO dispara o agente nem grava a mensagem do paciente
  // — quem faz isso é o widget.controller. Evita resposta duplicada e turno de
  // IA em dobro (o mesmo princípio do isMetaPrimary).
  if (unit.kommoWidgetReplyEnabled) {
    logger.debug(
      { unit: unit.slug },
      'kommo webhook: modo widget ligado, ignorando gatilho do agente (entrega via /widget)',
    );
    res.status(200).json({
      ok: true,
      skipped: 'widget_mode',
      converted: conversion.converted,
      unit: unit.slug,
    });
    return;
  }

  // PREVENÇÃO DE LOOP: só rodamos o agente quando há mensagem real do lead
  // (message.add com type=incoming) OU quando é uma chamada manual de teste
  // (leadId + text no body). Webhooks de `leads.update` disparados por NOSSAS
  // próprias mutações (setar Resposta IA, mover etapa) NÃO devem reativar o
  // agente — senão entramos em loop infinito processando nossas mudanças.
  const incomingMsg = getIncomingMessage(parsed.data);
  const hasIncomingMessage = !!incomingMsg;
  const hasManualTestInput = !!parsed.data.leadId && !!parsed.data.text;

  // Dedup por id da mensagem do Kommo — retry do webhook não dispara 2 turnos
  // de IA. Sem id (payload manual de teste, p.ex.) deixamos passar.
  if (incomingMsg?.id && !claimMessageId('kommo', incomingMsg.id)) {
    logger.info(
      { unit: unit.slug, msgId: incomingMsg.id },
      'kommo webhook duplicado (retry) — ignorando',
    );
    res.status(200).json({ ok: true, skipped: 'duplicate_message_id', unit: unit.slug });
    return;
  }

  if (!hasIncomingMessage && !hasManualTestInput) {
    logger.debug(
      { unit: unit.slug, hasLeadsUpdate: !!parsed.data.leads?.update?.length },
      'kommo webhook: nenhuma mensagem entrante, pulando agente (provável eco da própria mutação)',
    );
    res.status(200).json({
      ok: true,
      skipped: 'no_incoming_message',
      converted: conversion.converted,
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

  // Coalescer: junta mensagens em rajada num único run do agente. Se o lead
  // mandar 3 msgs em sequência, só roda o agente UMA vez (após 3s de silêncio)
  // com tudo combinado — evita 3 respostas duplicadas.
  const status = scheduleAgentRun({
    unitSlug: unit.slug,
    leadId,
    traceId: trace.id,
    humanMessage: ctx.humanMessage,
    audioUrl: ctx.audioUrl,
    run: async (combinedMessage, audioUrls, traceIds) => {
      // Marca traces "satélites" do burst (todos menos o primeiro) como
      // coalescidos, pra ficar claro no painel que não rodaram a IA sozinhos.
      const ownerTraceId = traceIds[0];
      const satelliteTraceIds = traceIds.slice(1);
      if (satelliteTraceIds.length > 0) {
        await prisma.executionTrace.updateMany({
          where: { id: { in: satelliteTraceIds } },
          data: {
            status: 'SUCCESS',
            iaDecision: `__coalesced_into__:${ownerTraceId}`,
            latencyMs: 0,
          },
        });
      }
      // Roda processAgent com a mensagem combinada e o trace dono.
      await processAgent({
        unit,
        leadId,
        traceId: ownerTraceId,
        humanMessage: combinedMessage,
        // Áudio: por enquanto pega só o 1º — combinar transcrições de múltiplos
        // áudios no mesmo turno é caso raro. Se virar comum, evoluir.
        audioUrl: audioUrls[0] ?? null,
        chatId: ctx.chatId,
        talkId: ctx.talkId,
        contactId: ctx.contactId,
        isChatMessage: ctx.isChatMessage,
        requestStart,
        burstSize: traceIds.length,
      });
    },
  });

  if (status === 'joined') {
    logger.info(
      { leadId, traceId: trace.id, unit: unit.slug },
      'webhook: mensagem anexada a burst em curso',
    );
  } else if (status === 'rejected') {
    // Burst cheio (>20 msgs). Roda esta mensagem isoladamente como fallback.
    void processAgent({
      unit,
      leadId,
      traceId: trace.id,
      humanMessage: ctx.humanMessage,
      audioUrl: ctx.audioUrl,
      chatId: ctx.chatId,
      talkId: ctx.talkId,
      contactId: ctx.contactId,
      isChatMessage: ctx.isChatMessage,
      requestStart,
    }).catch((err) => {
      logger.error({ err, traceId: trace.id }, 'erro fatal no background do agente (fallback)');
    });
  }
}

// ---------------------------------------------------------------------------
// Processamento assíncrono.
// ---------------------------------------------------------------------------

/** Entrega customizada da resposta. Quando fornecida ao processAgent, é usada
 *  no lugar do sendChatReply (PATCH+Digital Pipeline). É o ponto de extensão do
 *  MODO WIDGET: o widget.controller passa um deliver que retoma o Salesbot via
 *  return_url. Convenção: `deliver('')` finaliza o fluxo SEM enviar texto —
 *  usado pelos guards (IA pausada etc.) pra liberar o bot pausado. */
export type AgentDeliverFn = (text: string) => Promise<{ via: string; detail: unknown }>;

export async function processAgent(args: {
  unit: Unit;
  leadId: number;
  traceId: string;
  humanMessage: string;
  audioUrl: string | null;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  isChatMessage: boolean;
  requestStart: number;
  /** Quantas mensagens do burst foram coalescidas nesta execução. >1 quando o
   *  paciente mandou várias msgs em sequência e o debouncer juntou. */
  burstSize?: number;
  /** MODO WIDGET — ver AgentDeliverFn. Ausente = caminho legado (sendChatReply). */
  deliver?: AgentDeliverFn;
}): Promise<void> {
  const { unit, leadId, traceId, audioUrl, chatId, talkId, contactId, isChatMessage, requestStart, burstSize, deliver } = args;
  let { humanMessage } = args;
  // MODO WIDGET: garante que o Salesbot pausado seja retomado EXATAMENTE uma vez
  // (resposta, mensagem de guard, ou fallback de erro). Sem isso o bot trava.
  let delivered = false;
  const finishWidgetSilently = async (): Promise<void> => {
    if (deliver && !delivered) {
      delivered = true;
      try {
        await deliver('');
      } catch (e) {
        logger.warn({ err: e, traceId, leadId }, 'widget: falha ao finalizar bot sem texto');
      }
    }
  };
  const recorder = new TraceRecorder(traceId, unit.id);
  await syncRecorderSequence(recorder, traceId);

  // Registra no trace se este turno é resultado de coalescência (>1 mensagem).
  if (burstSize && burstSize > 1) {
    await recorder.step({
      kind: 'THINKING',
      title: `Burst coalescido: ${burstSize} mensagens do paciente combinadas em 1 turno`,
      payload: { burstSize, combined: humanMessage.slice(0, 400) },
    });
  }

  // Se cliente mandou áudio, transcreve antes de chamar a IA.
  if (audioUrl) {
    try {
      const t = await transcribeAudio(unit, audioUrl);
      const transcript = t.text || '[áudio sem fala detectada]';
      humanMessage = humanMessage ? `${humanMessage}\n\n[áudio do cliente]: ${transcript}` : transcript;
      await recorder.step({
        kind: 'THINKING',
        title: `Áudio transcrito (${t.durationMs}ms): "${transcript.slice(0, 80)}"`,
        payload: { audioUrl, transcript, ms: t.durationMs },
        latencyMs: t.durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, audioUrl, leadId }, 'falha ao transcrever áudio');
      await recorder.step({
        kind: 'ERROR',
        title: `Falha ao transcrever áudio: ${msg}`,
        payload: { audioUrl, error: msg },
      });
      // Não aborta — cai pra mensagem default avisando.
      humanMessage = humanMessage || '[cliente mandou um áudio, mas não foi possível transcrever]';
    }
  }

  // Guard: horário comercial. Se a Unit está fora do horário configurado,
  // pulamos a LLM e mandamos a mensagem padrão de "fora do expediente" via
  // Salesbot (mesma técnica de PATCH no campo Resposta IA).
  const hours = checkBusinessHours(unit);
  if (hours.enabled && !hours.isOpen && hours.outOfHoursMessage) {
    try {
      if (deliver) {
        // Widget: entrega a mensagem fora-horário retomando o Salesbot.
        delivered = true;
        await deliver(hours.outOfHoursMessage);
      } else if (unit.kommoSalesbotId && unit.kommoReplyFieldId) {
        const kommo = createKommoClient(unit);
        await kommo.runSalesbot({
          leadId,
          salesbotId: unit.kommoSalesbotId,
          replyFieldId: unit.kommoReplyFieldId,
          text: hours.outOfHoursMessage,
        });
      }
    } catch (err) {
      logger.warn({ err, leadId, unit: unit.slug }, 'erro ao enviar mensagem fora-horário');
    }
    await recorder.step({
      kind: 'COMPLETED',
      title: 'Fora do horário comercial — mensagem padrão enviada',
      payload: { leadId, message: hours.outOfHoursMessage },
    });
    await recorder.finalize({
      status: 'SUCCESS',
      latencyMs: Math.round(performance.now() - requestStart),
      iaDecision: '__out_of_hours__',
    });
    logger.info({ traceId, leadId, unit: unit.slug }, 'agente pulado (fora do horário comercial)');
    return;
  }

  // Guard: se operador humano marcou "IA Pausada", não invocamos o agente.
  // Verificação síncrona porque é 1 GET barato comparado ao custo da LLM.
  if (await isLeadPaused(unit, leadId)) {
    await finishWidgetSilently(); // libera o Salesbot pausado (modo widget)
    const totalLatency = Math.round(performance.now() - requestStart);
    await recorder.step({
      kind: 'COMPLETED',
      title: 'IA pausada por humano — agente não respondeu',
      payload: { leadId, reason: 'kommo_paused_field_checked' },
      latencyMs: totalLatency,
    });
    await recorder.finalize({
      status: 'SUCCESS',
      latencyMs: totalLatency,
      iaDecision: '__paused__',
    });
    logger.info({ traceId, leadId, unit: unit.slug }, 'agente pulado (IA Pausada)');
    return;
  }

  // Guards que dependem da ETAPA atual do lead. Ambos precisam de 1 GET no
  // lead, então buscamos uma vez só e cruzamos os dois:
  //   1. unit.kommoAllowedStatusIds (allowlist por unidade): se preenchida, a
  //      IA SÓ responde quando o lead está numa dessas etapas. Qualquer outra
  //      (ex: agendado, em tratamento) → pula. Lista vazia = responde em tudo.
  //   2. pause_in_stages (regra global, super-admin): etapas onde a IA fica
  //      pausada. Cruza com o Set agregado de pares (pipelineId, statusId).
  try {
    const allowedStatusIds = unit.kommoAllowedStatusIds ?? [];
    const pausedStages = await getPausedStagesGlobalSet();
    if (allowedStatusIds.length > 0 || pausedStages.size > 0) {
      const kommo = createKommoClient(unit);
      const lead = await kommo.getLead(leadId);
      const sid = lead.status_id;
      const pid = lead.pipeline_id;

      // Allowlist por unidade: se preenchida e o lead NÃO está numa etapa
      // permitida, a IA não responde. (sid ausente → trata como não permitido.)
      if (allowedStatusIds.length > 0 && (!sid || !allowedStatusIds.includes(sid))) {
        await finishWidgetSilently(); // libera o Salesbot pausado (modo widget)
        const totalLatency = Math.round(performance.now() - requestStart);
        await recorder.step({
          kind: 'COMPLETED',
          title: `IA não responde nesta etapa — lead em ${sid ?? '?'} (pipeline ${pid ?? '?'}), fora das etapas permitidas`,
          payload: {
            leadId,
            statusId: sid,
            pipelineId: pid,
            allowedStatusIds,
            reason: 'stage_not_in_allowlist',
          },
          latencyMs: totalLatency,
        });
        await recorder.finalize({
          status: 'SUCCESS',
          latencyMs: totalLatency,
          iaDecision: '__stage_not_allowed__',
        });
        logger.info(
          { traceId, leadId, unit: unit.slug, statusId: sid, pipelineId: pid, allowedStatusIds },
          'agente pulado (etapa fora da allowlist kommoAllowedStatusIds)',
        );
        return;
      }

      const matched =
        (sid && pausedStages.has(`*:${sid}`)) ||
        (sid && pid && pausedStages.has(`${pid}:${sid}`));
      if (matched) {
        await finishWidgetSilently(); // libera o Salesbot pausado (modo widget)
        const totalLatency = Math.round(performance.now() - requestStart);
        await recorder.step({
          kind: 'COMPLETED',
          title: `IA pausada por regra global — lead em etapa ${sid} (pipeline ${pid})`,
          payload: {
            leadId,
            statusId: sid,
            pipelineId: pid,
            reason: 'global_rule_pause_in_stages',
          },
          latencyMs: totalLatency,
        });
        await recorder.finalize({
          status: 'SUCCESS',
          latencyMs: totalLatency,
          iaDecision: '__paused_by_stage__',
        });
        logger.info(
          { traceId, leadId, unit: unit.slug, statusId: sid, pipelineId: pid },
          'agente pulado (regra global pause_in_stages)',
        );
        return;
      }
    }
  } catch (err) {
    // Guard nunca pode derrubar o agente — se a checagem falhou, segue normal.
    logger.warn({ err, leadId, unit: unit.slug }, 'falha no guard de etapa (allowlist/pause_in_stages) — seguindo');
  }

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
      const conv = await upsertConversation({
        unitId: unit.id,
        leadId: String(leadId),
        channel: 'kommo_chat',
      });
      // Pausa "humanizada" antes de enviar a resposta. Configurável por Unit
      // pra evitar o feel "robô instantâneo". Cap em 30s pra não travar webhook.
      const delaySec = Math.max(0, Math.min(unit.personaResponseDelaySec ?? 0, 30));
      if (delaySec > 0) {
        await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
      }

      // Trava anti-loop por lead: garante um intervalo MÍNIMO entre DUAS
      // respostas no MESMO lead (o anti-loop do Kommo trava quando duas saem
      // muito próximas). Configurável por Unit; 0 = desligado. Vale pro modo
      // widget e pro legado — os dois entregam resposta no mesmo lead.
      await enforceReplyGap(unit.id, leadId, unit.personaMinReplyGapSec ?? 0);

      // ÁUDIO DE SAÍDA (TESTE): se o cliente mandou áudio, devolvemos em VOZ.
      // Gera TTS, guarda em memória e troca o texto pelo LINK entre [colchetes]
      // — o Salesbot do Kommo interpreta `[url]` no campo Resposta IA como
      // arquivo e entrega como nota de voz. Só no caminho LEGADO: o modo widget
      // (execute_handlers show:text) mostraria o link como texto literal.
      // Falhou o TTS? cai de volta pro texto (outgoing = reply).
      let outgoing = reply;
      if (audioUrl && !deliver) {
        try {
          const speech = await synthesizeSpeech(unit, reply);
          const id = putAudio(speech.buffer, speech.contentType, speech.ext);
          const publicUrl = `${env.BACKEND_PUBLIC_URL}/audio/${id}.${speech.ext}`;
          outgoing = `[${publicUrl}]`;
          await recorder.step({
            kind: 'THINKING',
            title: `Resposta convertida em áudio (${speech.durationMs}ms) — enviando como nota de voz`,
            payload: { publicUrl, bytes: speech.buffer.byteLength, ttsMs: speech.durationMs, text: reply },
            latencyMs: speech.durationMs,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, leadId }, 'falha ao gerar áudio TTS — caindo pra texto');
          await recorder.step({
            kind: 'ERROR',
            title: `Falha ao gerar áudio (TTS): ${msg} — enviando em texto`,
            payload: { error: msg },
          });
        }
      }

      const sendStart = performance.now();
      try {
        // MODO WIDGET usa o deliver (retoma o Salesbot via return_url);
        // caminho legado usa sendChatReply (PATCH + Digital Pipeline).
        let sendResult: { via: string; detail?: unknown };
        if (deliver) {
          delivered = true;
          sendResult = await deliver(outgoing);
        } else {
          const kommo = createKommoClient(unit);
          sendResult = await kommo.sendChatReply({
            leadId,
            chatId,
            talkId,
            contactId,
            text: outgoing,
            recorder,
          });
        }
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Resposta entregue ao paciente via ${sendResult.via}`,
          payload: { reply, via: sendResult.via, detail: sendResult.detail },
          latencyMs: Math.round(performance.now() - sendStart),
        });
        // Monitor de "resposta parada": só a rota 'salesbot' depende do Kommo
        // entregar (PATCH no campo → bot dispara). 'chat_message' já saiu e
        // 'lead_note' nem foi pro paciente, então não rastreamos esses.
        if (sendResult.via === 'salesbot') {
          trackPendingReply({
            unitId: unit.id,
            unitSlug: unit.slug,
            unitName: unit.name,
            leadId: String(leadId),
            text: outgoing,
          });
        }
        // Registra turno do assistente na conversa.
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
    } else if (isChatMessage && deliver && !delivered) {
      // Widget: a IA não produziu texto (reply vazio). O Salesbot está pausado
      // esperando o continue — finaliza o fluxo sem mensagem pra não pendurar.
      await finishWidgetSilently();
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

    // Memória de longo prazo: agenda atualização em BACKGROUND.
    // NÃO bloqueia a resposta (já saiu). Updater faz throttle interno
    // pra não rodar a cada turno (custo desprezível ao longo prazo).
    scheduleLeadMemoryUpdate({
      unit,
      leadId,
      recentTurns: [
        { role: 'user', content: humanMessage },
        ...(reply ? [{ role: 'assistant' as const, content: reply }] : []),
      ],
    });

    logger.info({ traceId, leadId, ms: totalLatency, unit: unit.slug }, 'agente concluído');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const totalLatency = Math.round(performance.now() - requestStart);
    // MODO WIDGET: o Salesbot está pausado esperando o continue. Mesmo no erro,
    // precisamos retomá-lo (com um aviso curto) pra não deixá-lo pendurado.
    if (deliver && !delivered) {
      delivered = true;
      try {
        await deliver('Tive um probleminha técnico aqui, mas já já te respondo. 🙏');
      } catch (e) {
        logger.warn({ err: e, traceId, leadId }, 'widget: falha ao entregar fallback de erro');
      }
    }
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
