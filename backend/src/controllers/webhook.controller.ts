import type { Request, Response } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildAgentGraph, buildThreadId } from '../agent/graph.js';
import { TraceRecorder, syncRecorderSequence } from '../agent/trace-recorder.js';
import { createKommoClient, isLeadPaused, temPalavra } from '../services/kommo.service.js';
import { devoAvisar } from '../lib/paciente-insiste.js';
import { marcarNaoEntregue } from '../agent/entrega-falha.js';
import { tratarMensagemNaoRenderizada } from '../lib/mensagem-nao-renderizada.js';
import { detectarVazamento, explicarVazamento } from '../services/vazamento.js';
import { detectarInjecao, explicarInjecao, avisoDeInjecao } from '../services/injecao.js';
import { mascararPii } from '../lib/pii.js';
import { checkBusinessHours } from '../agent/prompt-composer.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { describeImage } from '../services/vision.service.js';
import { tentarNotaDeVoz } from '../lib/resposta-em-voz.js';
import { findUnitBySlug, ensureDefaultUnit } from '../services/units.service.js';
import { addMessage, upsertConversation } from '../services/conversations.service.js';
import { judgeConversation } from '../services/conversation-judge.service.js';
import { claimMessageId } from '../lib/dedup-cache.js';
import { rememberIncomingAudio } from '../lib/pending-audio.js';
import { enforceReplyGap } from '../lib/reply-gate.js';
import { trackPendingReply, confirmDelivery } from '../lib/stale-reply-monitor.js';
import { scheduleAgentRun } from '../lib/agent-coalescer.js';
import { ehEncerramentoRepetido } from '../lib/encerramento.js';
import { getPausedStagesGlobalSet } from '../services/actions.service.js';
import { scheduleLeadMemoryUpdate, carimbarContato } from '../services/lead-memory.service.js';
import { scheduleLeadMetrics } from '../services/lead-metrics.service.js';
import { SpineSyncService } from '../services/spine-sync.service.js';
import { z } from 'zod';

const attachmentSchema = z
  .object({
    type: z.string().optional(),
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
  type: z.string().optional(),
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

const leadStatusSchema = z.object({
  id: z.coerce.number(),
  status_id: z.coerce.number().optional(),
  old_status_id: z.coerce.number().optional(),
  pipeline_id: z.coerce.number().optional(),
});

const webhookSchema = z.object({
  account: z.object({ id: z.coerce.number().optional() }).partial().optional(),
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
  leadId: z.coerce.number().optional(),
  text: z.string().optional(),
});

type ParsedWebhook = z.infer<typeof webhookSchema>;
type MessageEvent = z.infer<typeof messageAddSchema>;

function getIncomingMessage(parsed: ParsedWebhook): MessageEvent | null {
  const messages = parsed.message?.add ?? [];
  const incoming = messages.find(
    (m) => (m.type ?? 'incoming') === 'incoming' && (m.text || hasAudioAttachment(m) || hasImageAttachment(m)),
  );
  return incoming ?? null;
}

function getOutgoingMessages(parsed: ParsedWebhook): MessageEvent[] {
  return (parsed.message?.add ?? []).filter((m) => (m.type ?? 'incoming') === 'outgoing');
}

const AUDIO_TYPES = new Set(['voice', 'audio']);
const AUDIO_EXT_RE = /\.(ogg|opus|mp3|m4a|wav|aac)$/i;

function hasAudioAttachment(msg: MessageEvent): boolean {
  return !!getAudioUrl(msg);
}

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

const IMAGE_TYPES = new Set(['image', 'picture', 'photo', 'sticker']);
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|bmp|heic)$/i;

function hasImageAttachment(msg: MessageEvent): boolean {
  return !!getImageUrl(msg);
}

function getImageUrl(msg: MessageEvent): string | null {
  const all = [
    ...(msg.attachment ? [msg.attachment] : []),
    ...(msg.attachments ?? []),
  ];
  for (const a of all) {
    if (!a.link) continue;
    const type = (a.type ?? '').toLowerCase();
    if (IMAGE_TYPES.has(type)) return a.link;
    const name = (a.file_name ?? a.name ?? a.link).toLowerCase();
    if (IMAGE_EXT_RE.test(name)) return a.link;
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
  imageUrl: string | null;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  contactName: string | null;
  /** Id (amojo) do paciente — destinatário da nota de voz. */
  authorId: string | null;
  /** Id numérico da conta Kommo que mandou o webhook. */
  accountId: number | null;
  isChatMessage: boolean;
}

function extractContext(parsed: ParsedWebhook, leadId: number): ExtractedContext {
  const msg = getIncomingMessage(parsed);
  const accountId = parsed.account?.id ?? null;
  if (msg) {
    return {
      humanMessage: msg.text ?? '',
      audioUrl: getAudioUrl(msg),
      imageUrl: getImageUrl(msg),
      chatId: msg.chat_id ?? null,
      talkId: msg.talk_id ?? null,
      contactId: msg.contact_id ?? null,
      contactName: msg.author?.name ?? null,
      authorId: msg.author?.id ?? null,
      accountId,
      isChatMessage: true,
    };
  }
  return {
    humanMessage: parsed.text ?? `Webhook recebido para lead ${leadId}. Analise e tome a melhor ação.`,
    audioUrl: null,
    imageUrl: null,
    chatId: null,
    talkId: null,
    contactId: null,
    contactName: null,
    authorId: null,
    accountId,
    isChatMessage: false,
  };
}

async function resolveUnit(req: Request): Promise<Unit | null> {
  const slug = req.params.unitSlug ? String(req.params.unitSlug) : '';
  if (slug) return findUnitBySlug(slug);
  return ensureDefaultUnit();
}

function detectedSchedulingIntent(messages: BaseMessage[]): boolean {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      start = i;
      break;
    }
  }
  for (let i = start; i < messages.length; i++) {
    const calls = (messages[i] as { tool_calls?: Array<{ name?: string; args?: unknown }> })
      .tool_calls;
    if (!calls || calls.length === 0) continue;
    for (const call of calls) {
      const name = (call.name ?? '').toLowerCase();
      const args = JSON.stringify(call.args ?? {}).toLowerCase();
      if (/prefer|horari/.test(name)) return true;
      if (/inten/.test(name) && /agend|marc|consulta|avalia/.test(args)) return true;
    }
  }
  return false;
}

async function resolveOwnerUnitByStage(entryUnit: Unit, leadId: number): Promise<Unit> {
  if (!entryUnit.kommoSubdomain) return entryUnit;
  const account = await prisma.unit.findMany({
    where: { kommoSubdomain: entryUnit.kommoSubdomain, isActive: true },
  });
  const hasSiblingAllow = account.some(
    (u) => u.id !== entryUnit.id && (u.kommoAllowedStatusIds?.length ?? 0) > 0,
  );
  if (!hasSiblingAllow) return entryUnit;

  let sid: number | undefined;
  try {
    const kommo = createKommoClient(entryUnit);
    const lead = await kommo.getLead(leadId);
    sid = lead.status_id ?? undefined;
  } catch (err) {
    logger.warn(
      { err, leadId, unit: entryUnit.slug },
      'router: falha ao ler a etapa do lead — usando unidade de entrada',
    );
    return entryUnit;
  }
  if (!sid) return entryUnit;

  const owner = account.find((u) => (u.kommoAllowedStatusIds ?? []).includes(sid!));
  if (owner && owner.id !== entryUnit.id) {
    logger.info(
      { leadId, from: entryUnit.slug, to: owner.slug, statusId: sid },
      'router: lead roteado por etapa pra IA dona',
    );
  }
  return owner ?? entryUnit;
}

function isMetaPrimary(unit: Unit): boolean {
  return !!unit.metaPhoneNumberId && !!unit.metaAccessToken;
}

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

  const conv = await prisma.conversation.upsert({
    where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
    update: {
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

  carimbarContato(unit.id, leadId, { desfecho: 'agendou' });

  void judgeConversation({ conversationId: conv.id, unit }).catch((err) => {
    logger.error({ err, conversationId: conv.id }, 'webhook: judge falhou em background');
  });

  return { converted: true, leadId, statusId };
}

/**
 * Guarda o WhatsApp do paciente na conversa, uma vez só.
 *
 * `conversations.phone` estava vazio em 100% das conversas até 01/09/2026:
 * só o Salesbot e o webhook da Meta gravavam, e o webhook do Kommo — que é o
 * caminho de TODAS as unidades Doutor Hérnia — nunca gravou. O efeito não era
 * cosmético: `cadastrar_paciente` exige telefone com DDD, então a IA pedia o
 * número ao paciente, e pedia na pior hora possível. Medido em teste: "me
 * manda o pix que eu pago agora" era respondido com "preciso confirmar seu
 * telefone com DDD", sem mandar a chave.
 *
 * Só busca quando ainda não tem número guardado, então é uma chamada por
 * conversa, não por mensagem. Falha aqui não pode derrubar o atendimento: se
 * o Kommo não responder, seguimos sem o telefone como era antes.
 */
async function guardarTelefoneDoContato(
  unit: Unit,
  conv: { id: string; phone: string | null },
  contactId: string | null,
): Promise<void> {
  if (conv.phone || !contactId) return;
  const id = Number(contactId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    const phone = await createKommoClient(unit).getContactPhone(id);
    if (!phone) return;
    await prisma.conversation.update({ where: { id: conv.id }, data: { phone } });
    logger.debug({ unitId: unit.id, conversationId: conv.id }, 'telefone do contato guardado na conversa');
  } catch (err) {
    logger.warn({ err, unitId: unit.id, contactId }, 'não consegui ler o telefone do contato no Kommo');
  }
}

export async function handleKommoWebhook(req: Request, res: Response): Promise<void> {
  const requestStart = performance.now();

  let unit = await resolveUnit(req);
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

  let humanTakeoverLeadId: number | null = null;
  const respondedLeadIds = new Set<number>();
  for (const out of getOutgoingMessages(parsed.data)) {
    if (!out.entity_id) continue;
    const wasOurReply = confirmDelivery({ unitId: unit.id, leadId: out.entity_id, text: out.text });
    logger.info(
      {
        unit: unit.slug,
        leadId: out.entity_id,
        autor: out.author?.type ?? '(sem autor)',
        autorNome: out.author?.name ?? null,
        texto: (out.text ?? '').slice(0, 120),
        vazio: !out.text,
        consideradaNossa: wasOurReply,
      },
      'sonda-sla: mensagem de saida recebida',
    );
    if (wasOurReply) continue;
    respondedLeadIds.add(out.entity_id);
    if ((out.author?.type ?? '').toLowerCase() === 'user') {
      humanTakeoverLeadId = out.entity_id;
    }
  }

  if (respondedLeadIds.size > 0) {
    await prisma.conversation
      .updateMany({
        where: {
          unitId: unit.id,
          leadId: { in: [...respondedLeadIds].map(String) },
          handoffAt: { not: null },
        },
        data: { handoffAt: null },
      })
      .catch(() => undefined);
  }

  if (humanTakeoverLeadId && unit.kommoPausedFieldId) {
    try {
      const kommo = createKommoClient(unit);
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

  if (unit.kommoWidgetReplyEnabled) {
    // O widget_request não carrega anexo — quando o paciente manda áudio, o
    // `{{message_text}}` chega vazio e o link do arquivo só existe AQUI. Guarda
    // pro /widget buscar daqui a pouco (ver lib/pending-audio).
    const msgEntrando = getIncomingMessage(parsed.data);
    const audioEntrando = msgEntrando ? getAudioUrl(msgEntrando) : null;
    if (audioEntrando && msgEntrando?.entity_id) {
      rememberIncomingAudio(unit.id, msgEntrando.entity_id, audioEntrando);
      logger.info(
        { unit: unit.slug, leadId: msgEntrando.entity_id },
        'kommo webhook: áudio de entrada guardado pro modo widget',
      );
    }

    // O Kommo só tem gatilho de "chat iniciado", que não dispara da 2ª mensagem
    // em diante — por isso a IA respondia uma vez e emudecia. Aqui a gente
    // mesmo lança o bot do widget a cada mensagem recebida.
    const widgetBotId = unit.kommoWidgetSalesbotId;
    if (widgetBotId && msgEntrando?.entity_id) {
      const unidade = unit;
      const leadDoBot = msgEntrando.entity_id;
      const chaveDedup = msgEntrando.id ?? `${leadDoBot}:${msgEntrando.text ?? ''}`;
      if (await claimMessageId('widget-run', chaveDedup)) {
        // Tem que ser pelo CONTATO. Com `leads` o Kommo roda o bot como
        // marketingbot, sem conversa — o `show` é aceito e jogado fora.
        const doWebhook = Number(msgEntrando.contact_id);
        void (async () => {
          const kommo = createKommoClient(unidade);
          const contatoId =
            Number.isFinite(doWebhook) && doWebhook > 0
              ? doWebhook
              : await kommo.getFirstContactId(leadDoBot);
          if (!contatoId) {
            logger.warn(
              { unit: unidade.slug, leadId: leadDoBot },
              'widget: lead sem contato — não dá pra lançar o bot em contexto de chat',
            );
            return;
          }
          await kommo.runBot(widgetBotId, contatoId, 'contacts');
        })().catch((err) => {
          logger.warn(
            { err, unit: unidade.slug, leadId: leadDoBot, botId: widgetBotId },
            'widget: falha ao lançar o Salesbot por API',
          );
        });
      }
    }
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

  const incomingMsg = getIncomingMessage(parsed.data);
  const hasIncomingMessage = !!incomingMsg;
  const hasManualTestInput = !!parsed.data.leadId && !!parsed.data.text;

  if (incomingMsg?.id && !(await claimMessageId('kommo', incomingMsg.id))) {
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

  unit = await resolveOwnerUnitByStage(unit, leadId);

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

  if (ctx.isChatMessage) {
    const conv = await upsertConversation({
      unitId: unit.id,
      leadId: String(leadId),
      contactName: ctx.contactName,
      channel: 'kommo_chat',
    });
    await guardarTelefoneDoContato(unit, conv, ctx.contactId);
    await addMessage({
      conversationId: conv.id,
      traceId: trace.id,
      role: 'user',
      content: ctx.humanMessage,
      meta: { chatId: ctx.chatId, talkId: ctx.talkId, contactId: ctx.contactId },
    });

    // "Ok obrigado" → despedida. "🙏" logo depois → silêncio. Sem isto cada
    // agradecimento virava mais uma despedida (Carlos, Parauapebas, 04/09/2026).
    const anteriores = await prisma.message.findMany({
      where: { conversationId: conv.id, traceId: { not: trace.id } },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { role: true, content: true, createdAt: true },
    });
    if (ehEncerramentoRepetido(ctx.humanMessage, anteriores)) {
      await recorder.step({
        kind: 'COMPLETED',
        title: 'Encerramento repetido — sem resposta, para não repetir a despedida',
        payload: { mensagem: ctx.humanMessage.slice(0, 80) },
      });
      await recorder.finalize({
        status: 'SUCCESS',
        latencyMs: Date.now() - trace.createdAt.getTime(),
        iaDecision: '__encerramento_repetido__',
      });
      logger.info({ unit: unit.slug, leadId, traceId: trace.id }, 'agente pulado (encerramento repetido)');
      res.status(200).json({ ok: true, traceId: trace.id, unit: unit.slug, skipped: 'encerramento_repetido' });
      return;
    }
  }

  res.status(200).json({ ok: true, traceId: trace.id, unit: unit.slug });

  const status = scheduleAgentRun({
    unitSlug: unit.slug,
    leadId,
    traceId: trace.id,
    humanMessage: ctx.humanMessage,
    audioUrl: ctx.audioUrl,
    imageUrl: ctx.imageUrl,
    run: async (combinedMessage, audioUrls, imageUrls, traceIds) => {
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
      await processAgent({
        unit,
        leadId,
        traceId: ownerTraceId,
        humanMessage: combinedMessage,
        audioUrl: audioUrls[0] ?? null,
        imageUrl: imageUrls[0] ?? null,
        chatId: ctx.chatId,
        talkId: ctx.talkId,
        contactId: ctx.contactId,
        authorId: ctx.authorId,
        accountId: ctx.accountId,
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
    void processAgent({
      unit,
      leadId,
      traceId: trace.id,
      humanMessage: ctx.humanMessage,
      audioUrl: ctx.audioUrl,
      imageUrl: ctx.imageUrl,
      chatId: ctx.chatId,
      talkId: ctx.talkId,
      contactId: ctx.contactId,
      authorId: ctx.authorId,
      accountId: ctx.accountId,
      isChatMessage: ctx.isChatMessage,
      requestStart,
    }).catch((err) => {
      logger.error({ err, traceId: trace.id }, 'erro fatal no background do agente (fallback)');
    });
  }
}

export type AgentDeliverFn = (text: string) => Promise<{ via: string; detail: unknown }>;

export async function processAgent(args: {
  unit: Unit;
  leadId: number;
  traceId: string;
  humanMessage: string;
  audioUrl: string | null;
  imageUrl: string | null;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  authorId?: string | null;
  accountId?: number | null;
  isChatMessage: boolean;
  requestStart: number;
  burstSize?: number;
  deliver?: AgentDeliverFn;
}): Promise<void> {
  const { unit, leadId, traceId, audioUrl, imageUrl, chatId, talkId, contactId, isChatMessage, requestStart, burstSize, deliver } = args;
  const authorId = args.authorId ?? null;
  const accountId = args.accountId ?? null;
  let { humanMessage } = args;
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

  if (burstSize && burstSize > 1) {
    await recorder.step({
      kind: 'THINKING',
      title: `Burst coalescido: ${burstSize} mensagens do paciente combinadas em 1 turno`,
      payload: { burstSize, combined: humanMessage.slice(0, 400) },
    });
  }

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
      humanMessage =
        humanMessage ||
        '[o paciente mandou um áudio que não deu pra entender. Peça com gentileza pra ele ' +
          'gravar de novo ou escrever. NÃO diga que ele falou em outro idioma nem peça pra ' +
          'ele falar em português — o problema foi na nossa captação do áudio.]';
    }
  }

  if (imageUrl) {
    try {
      const d = await describeImage(unit, imageUrl);
      const desc = d.text || '[imagem sem conteúdo legível]';
      humanMessage = humanMessage
        ? `${humanMessage}\n\n[imagem do cliente]: ${desc}`
        : `[imagem do cliente]: ${desc}`;
      await recorder.step({
        kind: 'THINKING',
        title: `Imagem lida (${d.durationMs}ms): "${desc.slice(0, 80)}"`,
        payload: { imageUrl, desc, ms: d.durationMs },
        latencyMs: d.durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, imageUrl, leadId }, 'falha ao ler imagem');
      await recorder.step({
        kind: 'ERROR',
        title: `Falha ao ler imagem: ${msg}`,
        payload: { imageUrl, error: msg },
      });
      humanMessage = humanMessage || '[cliente mandou uma imagem, mas não foi possível ler]';
    }
  }

  // O Kommo entrega um aviso de erro em inglês no lugar do conteúdo quando não
  // consegue exibir a mensagem (erro 131060). Sem trocar aqui, a IA responde ao
  // aviso achando que é fala do paciente — 81 vezes em 7 dias.
  humanMessage = tratarMensagemNaoRenderizada(humanMessage);

  const hours = checkBusinessHours(unit);
  if (hours.enabled && !hours.isOpen && hours.outOfHoursMessage) {
    try {
      if (deliver) {
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

  if (await isLeadPaused(unit, leadId)) {
    carimbarContato(unit.id, leadId, { desfecho: 'pediu_humano' });
    await finishWidgetSilently();

    // O paciente continua escrevendo e a IA está desligada. Antes isso morria
    // aqui em silêncio; agora vira tarefa no cartão, que o fluxo de alertas
    // leva pro grupo. A IA segue pausada — quem assume é gente.
    if (humanMessage.trim() && isChatMessage && devoAvisar(`${unit.id}:${leadId}`)) {
      try {
        await createKommoClient(unit).createTask({
          leadId,
          text:
            `ALERTA · ${unit.slug} · ` +
            'O paciente continuou escrevendo com a IA pausada e ninguém respondeu. ' +
            `Última mensagem: "${humanMessage.trim().slice(0, 120)}"`,
          completeAt: Math.floor(Date.now() / 1000),
        });
        logger.info({ leadId, unit: unit.slug }, 'paciente insistiu com a IA pausada — equipe avisada');
      } catch (err) {
        logger.warn({ err: String(err), leadId, unit: unit.slug }, 'falha ao avisar que o paciente insistiu — segue');
      }
    }

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

  try {
    const allowedStatusIds = unit.kommoAllowedStatusIds ?? [];
    const pausedStages = await getPausedStagesGlobalSet();
    if (allowedStatusIds.length > 0 || pausedStages.size > 0) {
      const kommo = createKommoClient(unit);
      const lead = await kommo.getLead(leadId);
      const sid = lead.status_id;
      const pid = lead.pipeline_id;

      if (allowedStatusIds.length > 0 && (!sid || !allowedStatusIds.includes(sid))) {
        await finishWidgetSilently();
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
        await finishWidgetSilently();
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
    logger.warn({ err, leadId, unit: unit.slug }, 'falha no guard de etapa (allowlist/pause_in_stages) — seguindo');
  }

  try {
    const graph = await buildAgentGraph(recorder, unit, leadId);
    const threadId = buildThreadId(unit.slug, leadId);

    // Mensagem que parece dar ORDEM à IA não bloqueia o atendimento — paciente
    // escreve coisa estranha o tempo todo, e recusar por suspeita custa lead.
    // O que fazemos é avisar o modelo, num bloco próprio, de que aquilo é texto
    // do paciente e não instrução. A trava contra o estrago está no código (lead
    // e paciente fixos), não aqui; isto é a segunda camada.
    const injecao = detectarInjecao(humanMessage);
    if (injecao) {
      logger.warn(
        { traceId, leadId, unit: unit.slug, tipo: injecao.tipo, trecho: mascararPii(injecao.trecho) },
        `mensagem do paciente parece tentar dar ordem à IA: ${explicarInjecao(injecao)}`,
      );
      await recorder.step({
        kind: 'ERROR',
        title: `🛡 ${explicarInjecao(injecao)} ("${injecao.trecho.slice(0, 46)}")`,
        payload: { leadId, tipo: injecao.tipo, trecho: injecao.trecho },
      });
    }
    const mensagemParaIa = injecao
      ? `${avisoDeInjecao(injecao)}\n\n${humanMessage}`
      : humanMessage;

    const result = await graph.invoke(
      {
        leadId,
        traceId,
        messages: [new HumanMessage(mensagemParaIa)],
      },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 24,
      },
    );

    const reply = (result.decision ?? '').toString().trim();

    const respostaSemPalavra = reply.length > 0 && !temPalavra(reply);
    if (respostaSemPalavra) {
      logger.warn(
        { traceId, leadId, unit: unit.slug, reply: mascararPii(reply) },
        'resposta só com emoji/pontuação — descartada, nada enviado ao paciente',
      );
      await recorder.step({
        kind: 'THINKING',
        title: `🚫 Resposta descartada — só emoji/pontuação ("${reply.slice(0, 24)}")`,
        payload: { leadId, reply, motivo: 'resposta_sem_palavra' },
      });
    }

    // Bastidor não vai pro paciente. Já aconteceu duas vezes: um lead de Porto
    // recebeu o raciocínio do modelo em inglês, e na simulação saiu a chamada da
    // ferramenta escrita como texto. Nesses casos é melhor o paciente ficar sem
    // resposta neste turno (ele reescreve, e a IA responde de novo) do que
    // receber lixo — que quebra a confiança na hora e não tem desfazer.
    const vazamento = reply ? detectarVazamento(reply) : null;
    if (vazamento) {
      logger.error(
        { traceId, leadId, unit: unit.slug, tipo: vazamento.tipo, trecho: vazamento.trecho, reply: mascararPii(reply) },
        `resposta bloqueada: ${explicarVazamento(vazamento)}`,
      );
      await recorder.step({
        kind: 'ERROR',
        title: `🚫 Resposta bloqueada — ${explicarVazamento(vazamento)} ("${vazamento.trecho.slice(0, 40)}")`,
        payload: { leadId, tipo: vazamento.tipo, trecho: vazamento.trecho, reply },
      });
    }

    const podeEnviar = !respostaSemPalavra && !vazamento;

    if (isChatMessage && reply && podeEnviar) {
      const conv = await upsertConversation({
        unitId: unit.id,
        leadId: String(leadId),
        channel: 'kommo_chat',
      });
      const delaySec = Math.max(0, Math.min(unit.personaResponseDelaySec ?? 0, 30));
      if (delaySec > 0) {
        await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
      }

      await enforceReplyGap(unit.id, leadId, unit.personaMinReplyGapSec ?? 0);

      const sendStart = performance.now();
      try {
        let sendResult: { via: string; detail?: unknown };
        // Espelho: paciente mandou áudio → tenta nota de voz. `null` = siga em texto.
        const voz = await tentarNotaDeVoz({
          unit, leadId, reply, audioUrl, chatId, talkId, contactId, authorId, accountId,
          modoWidget: !!deliver, recorder,
        });
        if (voz) {
          sendResult = voz;
        } else if (deliver) {
          delivered = true;
          sendResult = await deliver(reply);
        } else {
          const kommo = createKommoClient(unit);
          sendResult = await kommo.sendChatReply({
            leadId,
            chatId,
            talkId,
            contactId,
            text: reply,
            recorder,
          });
        }
        // `lead_note` não é entrega: a resposta virou nota interna no cartão e o
        // paciente não recebeu nada. Chamar isso de "entregue ao paciente"
        // escondeu 963 mensagens perdidas em 14 dias — a conversa seguia e
        // ninguém, nem a equipe nem a IA, desconfiava.
        const naoChegou = sendResult.via === 'lead_note';
        await recorder.step({
          kind: naoChegou ? 'ERROR' : 'KOMMO_ACTION',
          title: naoChegou
            ? '🔇 Resposta NÃO chegou ao paciente — virou nota interna no cartão'
            : `Resposta entregue ao paciente via ${sendResult.via}`,
          payload: { reply, via: sendResult.via, detail: sendResult.detail },
          latencyMs: Math.round(performance.now() - sendStart),
        });
        if (naoChegou) {
          // Pro próximo turno ela saber que o paciente não leu nada disso.
          marcarNaoEntregue(unit.id, leadId, reply);
        }
        if (naoChegou && devoAvisar(`entrega:${unit.id}:${leadId}`)) {
          try {
            await createKommoClient(unit).createTask({
              leadId,
              text:
                `ALERTA · ${unit.slug} · A resposta da IA NÃO chegou ao paciente ` +
                '(virou nota interna). Responder por aqui e avisar o suporte. ' +
                `Texto que ficou preso: "${reply.trim().slice(0, 110)}"`,
              completeAt: Math.floor(Date.now() / 1000),
            });
            logger.warn({ leadId, unit: unit.slug }, 'entrega falhou — equipe avisada');
          } catch (err) {
            logger.warn(
              { err: String(err), leadId, unit: unit.slug },
              'entrega falhou e o aviso à equipe também — segue',
            );
          }
        }
        if (sendResult.via === 'salesbot') {
          trackPendingReply({
            unitId: unit.id,
            unitSlug: unit.slug,
            unitName: unit.name,
            leadId: String(leadId),
            text: reply,
          });
        }
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
      await finishWidgetSilently();
    }

    const intents = unit.pipelineIntents as Record<string, number> | null;
    const handoffStage = intents?.handoff_scheduling;
    if (handoffStage && leadId > 0 && detectedSchedulingIntent(result.messages ?? [])) {
      try {
        const kommo = createKommoClient(unit);
        await kommo.moveStage({ leadId, statusId: handoffStage });
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Handoff automático → etapa ${handoffStage} (IA comercial assume)`,
          payload: { leadId, statusId: handoffStage, reason: 'scheduling_intent' },
        });
      } catch (handoffErr) {
        logger.warn(
          { err: String(handoffErr), leadId, unit: unit.slug },
          'handoff automático: falha ao mover etapa',
        );
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

    scheduleLeadMemoryUpdate({
      unit,
      leadId,
      recentTurns: [
        { role: 'user', content: humanMessage },
        ...(reply && podeEnviar ? [{ role: 'assistant' as const, content: reply }] : []),
      ],
    });

    scheduleLeadMetrics(unit, leadId);

    if (unit.spineSyncLeads && leadId > 0) {
      void SpineSyncService.syncLeadToSpine(unit, leadId).catch((err) => {
        logger.warn({ err: String(err), leadId, unit: unit.slug }, 'spine-sync: erro inesperado');
      });
    }

    logger.info({ traceId, leadId, ms: totalLatency, unit: unit.slug }, 'agente concluído');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const totalLatency = Math.round(performance.now() - requestStart);
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
