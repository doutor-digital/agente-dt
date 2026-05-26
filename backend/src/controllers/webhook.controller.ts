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
import { findUnitBySlug, ensureDefaultUnit } from '../services/units.service.js';
import { addMessage, isDuplicateAssistantReply, upsertConversation } from '../services/conversations.service.js';
import { judgeConversation } from '../services/conversation-judge.service.js';
import { claimMessageId } from '../lib/dedup-cache.js';
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

async function processAgent(args: {
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
}): Promise<void> {
  const { unit, leadId, traceId, audioUrl, chatId, talkId, contactId, isChatMessage, requestStart, burstSize } = args;
  let { humanMessage } = args;
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
      if (unit.kommoSalesbotId && unit.kommoReplyFieldId) {
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

  // Guard global: lead está em uma das etapas configuradas como "IA pausada"
  // pelas regras globais? (kind=pause_in_stages — gerenciado pelo super-admin)
  // Faz 1 GET no lead e cruza com o Set agregado de pares (pipelineId, statusId).
  try {
    const pausedStages = await getPausedStagesGlobalSet();
    if (pausedStages.size > 0) {
      const kommo = createKommoClient(unit);
      const lead = await kommo.getLead(leadId);
      const sid = lead.status_id;
      const pid = lead.pipeline_id;
      const matched =
        (sid && pausedStages.has(`*:${sid}`)) ||
        (sid && pid && pausedStages.has(`${pid}:${sid}`));
      if (matched) {
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
    logger.warn({ err, leadId, unit: unit.slug }, 'falha no guard pause_in_stages — seguindo');
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
      // ANTI-LOOP: se a última fala da IA for idêntica a esta (Kommo re-disparando
      // o envio em loop), NÃO reenvia. Corta a repetição na origem.
      if (await isDuplicateAssistantReply(conv.id, reply)) {
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: 'Envio cancelado — resposta idêntica à anterior (anti-loop)',
          payload: { reply },
        });
        logger.info({ traceId, leadId }, 'webhook: envio duplicado cancelado');
      } else {
      // Pausa "humanizada" antes de enviar a resposta. Configurável por Unit
      // pra evitar o feel "robô instantâneo". Cap em 30s pra não travar webhook.
      const delaySec = Math.max(0, Math.min(unit.personaResponseDelaySec ?? 0, 30));
      if (delaySec > 0) {
        await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
      }

      const sendStart = performance.now();
      try {
        const kommo = createKommoClient(unit);
        const sendResult = await kommo.sendChatReply({
          leadId,
          chatId,
          talkId,
          contactId,
          text: reply,
          recorder,
        });
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Resposta entregue ao paciente via ${sendResult.via}`,
          payload: { reply, via: sendResult.via, detail: sendResult.detail },
          latencyMs: Math.round(performance.now() - sendStart),
        });
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
