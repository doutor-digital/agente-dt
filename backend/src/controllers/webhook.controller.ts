// ============================================================================
// webhook.controller.ts — Recebe webhooks do Kommo.
//
// LÓGICA DE ENGENHARIA
// --------------------
// A Kommo timeoutsa webhooks em 30 segundos. Se demorarmos mais que isso,
// ela considera falha e RETENTA — gerando duplicação. Nossa LLM pode
// tranquilamente levar 5-15s para responder, então NÃO podemos processar
// síncronamente dentro do handler HTTP.
//
// Padrão adotado: "ACK rápido + processamento em background".
//
//   1. Recebe POST → valida payload mínimo.
//   2. Cria ExecutionTrace no banco (estado RUNNING).
//   3. Retorna HTTP 200 IMEDIATAMENTE.
//   4. Em background (fire-and-forget), invoca o grafo do LangGraph.
//   5. Quando o grafo termina, atualiza o trace com status + latência.
//
// Por que `performance.now()` e não `Date.now()`?
//   - `Date.now()` tem resolução de ms mas é sujeito a ajustes de NTP.
//   - `performance.now()` é monotônico — ideal para medir DURAÇÃO.
//   Para timestamp de criação usamos `new Date()` (precisa ser cronológico).
//
// Idempotência: a Kommo pode reentregar o mesmo webhook. Para o MVP,
// confiamos no thread_id do LangGraph: se vier a mesma mensagem duas vezes,
// o checkpoint reencaminha o State e a LLM provavelmente respondeu igual.
// Em produção, seria interessante deduplicar via header `X-Webhook-Id`.
// ============================================================================

import type { Request, Response } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildAgentGraph } from '../agent/graph.js';
import { TraceRecorder } from '../agent/trace-recorder.js';
import { KommoService } from '../services/kommo.service.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema de validação do payload.
// O Kommo manda o webhook em formato `application/x-www-form-urlencoded`
// com chaves aninhadas (ex: `leads[status][0][id]=123` ou
// `message[add][0][text]=oi`). O Express expande com `extended: true`.
//
// Dois formatos relevantes:
//
//   1. CRM events — `leads.{add|update|status}[]`: só vem metadado do lead,
//      sem texto. Usado por mudanças no funil/etapa.
//
//   2. Chat events — `message.add[]`: TRAZ O TEXTO da mensagem do paciente
//      junto com chat_id, talk_id, contact_id e origem (waba/telegram/...).
//      É esse o caminho real de conversação.
//
// O fallback `{ leadId, message }` continua aqui só pra facilitar testes
// locais com curl.
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

const webhookSchema = z.object({
  leads: z
    .object({
      add: z.array(z.object({ id: z.coerce.number() })).optional(),
      update: z.array(z.object({ id: z.coerce.number() })).optional(),
      status: z.array(z.object({ id: z.coerce.number() })).optional(),
    })
    .optional(),
  message: z
    .object({
      add: z.array(messageAddSchema).optional(),
    })
    .optional(),
  // Fallback para testes locais: { leadId, message } — `message` como string
  // pra não conflitar com `message.add[]`.
  leadId: z.coerce.number().optional(),
  text: z.string().optional(),
});

type ParsedWebhook = z.infer<typeof webhookSchema>;
type MessageEvent = z.infer<typeof messageAddSchema>;

function getIncomingMessage(parsed: ParsedWebhook): MessageEvent | null {
  const messages = parsed.message?.add ?? [];
  // Só reagimos a mensagens "incoming" — outgoing seriam respostas que
  // nós mesmos (ou um operador) acabamos de mandar; reagir a elas geraria loop.
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
  // Fallback de teste local OU evento de CRM puro (sem texto).
  return {
    humanMessage:
      parsed.text ?? `Webhook recebido para lead ${leadId}. Analise e tome a melhor ação.`,
    chatId: null,
    talkId: null,
    contactId: null,
    contactName: null,
    isChatMessage: false,
  };
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

export async function handleKommoWebhook(req: Request, res: Response): Promise<void> {
  const requestStart = performance.now();

  // 1. Valida payload.
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten() }, 'webhook inválido');
    res.status(400).json({ ok: false, error: 'invalid payload' });
    return;
  }

  const leadId = extractLeadId(parsed.data);
  if (!leadId) {
    logger.warn({ body: req.body }, 'webhook sem leadId');
    res.status(400).json({ ok: false, error: 'leadId not found in payload' });
    return;
  }

  const ctx = extractContext(parsed.data, leadId);

  // 2. Cria o trace ANTES do ACK pra garantir que o dashboard veja a
  //    execução mesmo se o processamento async demorar.
  const trace = await prisma.executionTrace.create({
    data: {
      threadId: `lead-${leadId}`,
      leadId: String(leadId),
      input: req.body as object,
      status: 'RUNNING',
    },
  });

  const recorder = new TraceRecorder(trace.id);
  await recorder.step({
    kind: 'WEBHOOK_RECEIVED',
    title: ctx.isChatMessage
      ? `Mensagem de ${ctx.contactName ?? 'paciente'} (Lead ${leadId}): "${ctx.humanMessage.slice(0, 80)}"`
      : `Payload recebido do Kommo (Lead ID ${leadId})`,
    payload: req.body as object,
  });

  // 3. ACK imediato — fundamental pra Kommo não retentar.
  res.status(200).json({ ok: true, traceId: trace.id });

  // 4. Processamento em background. Note o `.catch` — se algo aqui
  //    explodir e ninguém capturar, o Node 24 dispara unhandledRejection.
  void processAgent({
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
// Processamento async do agente.
// ---------------------------------------------------------------------------

async function processAgent(args: {
  leadId: number;
  traceId: string;
  humanMessage: string;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  isChatMessage: boolean;
  requestStart: number;
}): Promise<void> {
  const { leadId, traceId, humanMessage, chatId, talkId, contactId, isChatMessage, requestStart } =
    args;
  const recorder = new TraceRecorder(traceId);
  // Restaura sequence: como criamos um novo recorder, ele começa em 0.
  // O step WEBHOOK_RECEIVED já foi gravado pelo handler com seq=1, então
  // o próximo step que esse recorder gravar será seq=1 também — colidindo
  // com o unique [traceId, sequence]. Resolvemos puxando a contagem atual.
  await syncRecorderSequence(recorder, traceId);

  try {
    const graph = await buildAgentGraph(recorder);

    // thread_id estável por lead → memória de conversa contínua.
    const threadId = `lead-${leadId}`;

    const result = await graph.invoke(
      {
        leadId,
        traceId,
        messages: [new HumanMessage(humanMessage)],
      },
      {
        configurable: { thread_id: threadId },
        // Trava de segurança: evita loop infinito de tool_calls.
        recursionLimit: 10,
      },
    );

    const reply = (result.decision ?? '').toString().trim();

    // Se foi mensagem de chat real e a IA gerou resposta, entregamos ao
    // paciente via API do Kommo. Para eventos de CRM (sem chat), só logamos.
    if (isChatMessage && reply) {
      const sendStart = performance.now();
      try {
        const sendResult = await KommoService.sendChatReply({
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

    logger.info({ traceId, leadId, ms: totalLatency }, 'agente concluído');
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
    logger.error({ err, traceId, leadId }, 'agente falhou');
  }
}

// Helper: alinha o contador interno do recorder com o que já existe no banco.
async function syncRecorderSequence(recorder: TraceRecorder, traceId: string): Promise<void> {
  const last = await prisma.executionStep.findFirst({
    where: { traceId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  if (last) {
    // Pequeno truque: setamos o contador interno via atribuição direta.
    // `TraceRecorder` expõe a propriedade como private mas TS aceita via
    // cast porque é o mesmo arquivo de runtime — em produção valeria a
    // pena expor um setter explícito.
    (recorder as unknown as { sequence: number }).sequence = last.sequence;
  }
}
