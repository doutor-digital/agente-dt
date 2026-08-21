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
import type { BaseMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildAgentGraph, buildThreadId } from '../agent/graph.js';
import { TraceRecorder, syncRecorderSequence } from '../agent/trace-recorder.js';
import { createKommoClient, isLeadPaused, temPalavra } from '../services/kommo.service.js';
import { checkBusinessHours } from '../agent/prompt-composer.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { describeImage } from '../services/vision.service.js';
import { findUnitBySlug, ensureDefaultUnit } from '../services/units.service.js';
import { addMessage, upsertConversation } from '../services/conversations.service.js';
import { judgeConversation } from '../services/conversation-judge.service.js';
import { claimMessageId } from '../lib/dedup-cache.js';
import { enforceReplyGap } from '../lib/reply-gate.js';
import { trackPendingReply, confirmDelivery } from '../lib/stale-reply-monitor.js';
import { scheduleAgentRun } from '../lib/agent-coalescer.js';
import { getPausedStagesGlobalSet } from '../services/actions.service.js';
import { scheduleLeadMemoryUpdate, carimbarContato } from '../services/lead-memory.service.js';
import { scheduleLeadMetrics } from '../services/lead-metrics.service.js';
import { SpineSyncService } from '../services/spine-sync.service.js';
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
    (m) => (m.type ?? 'incoming') === 'incoming' && (m.text || hasAudioAttachment(m) || hasImageAttachment(m)),
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

const IMAGE_TYPES = new Set(['image', 'picture', 'photo', 'sticker']);
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|bmp|heic)$/i;

function hasImageAttachment(msg: MessageEvent): boolean {
  return !!getImageUrl(msg);
}

/** Retorna o URL da imagem da mensagem, ou null se não houver. */
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
  isChatMessage: boolean;
}

function extractContext(parsed: ParsedWebhook, leadId: number): ExtractedContext {
  const msg = getIncomingMessage(parsed);
  if (msg) {
    return {
      humanMessage: msg.text ?? '',
      audioUrl: getAudioUrl(msg),
      imageUrl: getImageUrl(msg),
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
    imageUrl: null,
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
// HANDOFF DETERMINÍSTICO — a IA de reativação (resgate) não agenda (SOLID).
//
// Quando o paciente demonstra que quer marcar, a resgate deveria "passar o
// bastão" movendo a etapa pra IA comercial. O prompt manda o LLM chamar
// mover_etapa, mas na prática o modelo banca o agendador ("vou verificar a
// disponibilidade…") e NÃO move — o lead trava em Perdido e ninguém agenda.
// Provado em teste: nem prompt endurecido nem upgrade de modelo (gpt-4o)
// resolvem de forma confiável. Então o CÓDIGO garante o handoff.
//
// Sinal: os tools de registro (registra_preferencia_horario / registra_intencao)
// disparam com 100% de confiabilidade quando o paciente quer marcar — olhamos
// as tool calls DESTE turno (após o último HumanMessage). Alvo da etapa vem de
// `pipelineIntents.handoff_scheduling` (config por unidade — generaliza p/ cada
// cidade; ausente = comportamento antigo, nada muda).
// ---------------------------------------------------------------------------
function detectedSchedulingIntent(messages: BaseMessage[]): boolean {
  // Só o turno atual: mensagens a partir do último HumanMessage.
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
      // Deu preferência de horário → inequivocamente quer marcar.
      if (/prefer|horari/.test(name)) return true;
      // Intenção capturada com valor de agendamento.
      if (/inten/.test(name) && /agend|marc|consulta|avalia/.test(args)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// ROTEADOR POR ETAPA (contas multi-IA — uma IA por etapa).
//
// Numa conta Kommo com várias unidades (comercial, resgate, tratamento…), o
// DONO do lead é a unidade cuja allowlist (`kommoAllowedStatusIds`) contém a
// ETAPA ATUAL do lead. Ex: Perdido (143) → resgate; Qualificação → comercial.
// É determinístico: 1 etapa = 1 IA, então nunca duas IAs respondem o mesmo
// lead (a etapa é a trava de estado / ownership).
//
// Backward-compatible: se a conta só tem uma IA (nenhuma irmã com allowlist),
// ou se nada casa com a etapa, devolve a unidade de entrada intacta — contas
// single-IA (ex: Serra) nem chegam a fazer o GET no lead.
// ---------------------------------------------------------------------------
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

  // Carimba o desfecho na memória do lead: se ele voltar meses depois, a IA
  // retoma sabendo que ele JÁ agendou — em vez de tratar como lead novo.
  carimbarContato(unit.id, leadId, { desfecho: 'agendou' });

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

  // Confirmação de entrega + detecção de takeover humano. O Kommo manda webhook
  // OUTGOING tanto quando o Salesbot entrega a NOSSA resposta quanto quando um
  // atendente responde na mão. confirmDelivery() devolve true se a outgoing
  // casou com uma resposta nossa pendente (= foi a IA). Uma outgoing que NÃO é
  // nossa e cujo autor é um usuário da conta (author.type="user") significa que
  // um humano assumiu — o cliente vem como author.type="external".
  let humanTakeoverLeadId: number | null = null;
  const respondedLeadIds = new Set<number>();
  for (const out of getOutgoingMessages(parsed.data)) {
    if (!out.entity_id) continue;
    const wasOurReply = confirmDelivery({ unitId: unit.id, leadId: out.entity_id, text: out.text });
    if (wasOurReply) continue; // foi a própria IA entregando — não conta como resposta externa
    // QUALQUER mensagem que sai pro lead (humano, TEMPLATE, automação) conta como
    // "respondido" pro SLA/reativação. Antes só author.type='user' contava, então
    // template escapava e o lead ficava constando "sem resposta".
    respondedLeadIds.add(out.entity_id);
    // Só resposta de USUÁRIO humano dispara a auto-pausa da IA (template/automação não).
    if ((out.author?.type ?? '').toLowerCase() === 'user') {
      humanTakeoverLeadId = out.entity_id;
    }
  }

  // Alguém respondeu (humano, template ou automação) → CANCELA a reativação e o
  // SLA. A equipe está tocando o lead; a IA não volta por cima e o alerta não
  // dispara. Zera o handoffAt que ambos os workers vigiam. É a trava "só age se
  // ninguém respondeu" — agora robusta a template, não só a msg de 'user'.
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

  // ROTEIA por etapa: a IA que roda daqui pra frente é a DONA da etapa atual do
  // lead (comercial, resgate, tratamento…). Trace, conversa e agente usam ela.
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
    imageUrl: ctx.imageUrl,
    run: async (combinedMessage, audioUrls, imageUrls, traceIds) => {
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
        // Áudio/imagem: por enquanto pega só o 1º — combinar vários no mesmo
        // turno é caso raro. Se virar comum, evoluir.
        audioUrl: audioUrls[0] ?? null,
        imageUrl: imageUrls[0] ?? null,
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
      imageUrl: ctx.imageUrl,
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
  imageUrl: string | null;
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
  const { unit, leadId, traceId, audioUrl, imageUrl, chatId, talkId, contactId, isChatMessage, requestStart, burstSize, deliver } = args;
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

  // Se cliente mandou imagem, lê (visão) antes de chamar a IA.
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
    // Passou pra um humano — registra o desfecho pra IA saber disso se o lead
    // voltar depois (não recomeçar do zero por cima de um atendimento humano).
    carimbarContato(unit.id, leadId, { desfecho: 'pediu_humano' });
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
        // O limite conta CADA passo do grafo — modelo e tool alternam, então
        // uma ferramenta custa dois. O caminho de agendamento hoje é
        // consultar_horarios → buscar_paciente → cadastrar_paciente →
        // agendar_consulta, mais os campos de qualificação que a IA grava no
        // mesmo turno: passa de 10 sem nenhuma retentativa. Estourar aqui não
        // degrada, ABORTA — o paciente fica sem resposta nenhuma.
        //
        // 24 cobre o caminho inteiro com folga para uma recuperação (horário
        // ocupado entre oferecer e fechar), e ainda barra loop de verdade.
        recursionLimit: 24,
      },
    );

    const reply = (result.decision ?? '').toString().trim();

    // A IA às vezes fecha o turno com uma resposta que é SÓ emoji ("✨", "🙏").
    // Aconteceu na Serra, em produção: o paciente contou a dor dele e recebeu
    // dois balões com "✨" e mais nada. O gatilho típico é a REAÇÃO do
    // WhatsApp — ela chega no webhook como se fosse uma mensagem de texto do
    // paciente ("🙏"), a IA "responde" no mesmo tom e o que sai é ruído.
    // Mensagem sem palavra nenhuma não é resposta: o turno morre aqui.
    const respostaSemPalavra = reply.length > 0 && !temPalavra(reply);
    if (respostaSemPalavra) {
      logger.warn(
        { traceId, leadId, unit: unit.slug, reply },
        'resposta só com emoji/pontuação — descartada, nada enviado ao paciente',
      );
      await recorder.step({
        kind: 'THINKING',
        title: `🚫 Resposta descartada — só emoji/pontuação ("${reply.slice(0, 24)}")`,
        payload: { leadId, reply, motivo: 'resposta_sem_palavra' },
      });
    }

    if (isChatMessage && reply && !respostaSemPalavra) {
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

      const sendStart = performance.now();
      try {
        // MODO WIDGET usa o deliver (retoma o Salesbot via return_url);
        // caminho legado usa sendChatReply (PATCH + Digital Pipeline).
        let sendResult: { via: string; detail?: unknown };
        if (deliver) {
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
            text: reply,
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

    // HANDOFF DETERMINÍSTICO resgate → comercial (ver comentário em
    // detectedSchedulingIntent). Roda DEPOIS de responder — não atrasa o
    // paciente. A resposta deste turno ainda sai pela resgate (frase-ponte);
    // a etapa muda pra IA comercial assumir a PARTIR da próxima mensagem.
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

    // Memória de longo prazo: agenda atualização em BACKGROUND.
    // NÃO bloqueia a resposta (já saiu). Updater faz throttle interno
    // pra não rodar a cada turno (custo desprezível ao longo prazo).
    scheduleLeadMemoryUpdate({
      unit,
      leadId,
      recentTurns: [
        { role: 'user', content: humanMessage },
        ...(reply && !respostaSemPalavra ? [{ role: 'assistant' as const, content: reply }] : []),
      ],
    });

    // Métricas calculadas (1ª resposta, tempo até 1ª resposta, nº de mensagens).
    // Fora do caminho da resposta — a mensagem já saiu.
    scheduleLeadMetrics(unit, leadId);

    // PONTE COM A FRANQUIA — depois de responder, nunca antes.
    // Roda a cada turno de propósito: o nome costuma aparecer no 2º ou 3º, e o
    // service ignora sozinho quem ainda tem título automático. O unique no
    // vínculo garante um cadastro só, então repetir é barato e não suja nada.
    // Fire-and-forget: se a franquia cair, o paciente segue sendo atendido.
    // Só `spineSyncLeads`. `spineEnabled` governa a AGENDA (consultar horário,
    // criar agendamento) — são decisões diferentes, e a tela as mostra como
    // dois interruptores independentes. Exigir os dois aqui fazia "Espelhar
    // leads: ligado" não espelhar nada, sem nada na tela denunciando.
    // Token e demais condições quem confere é o próprio service.
    if (unit.spineSyncLeads && leadId > 0) {
      void SpineSyncService.syncLeadToSpine(unit, leadId).catch((err) => {
        logger.warn({ err: String(err), leadId, unit: unit.slug }, 'spine-sync: erro inesperado');
      });
    }

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
