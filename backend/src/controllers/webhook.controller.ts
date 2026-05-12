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
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema de validação do payload.
// O Kommo manda o webhook em formato `application/x-www-form-urlencoded`
// com chaves aninhadas (ex: `leads[status][0][id]=123`). O Express já
// expande isso em objeto com `express.urlencoded({ extended: true })`.
// Para o MVP aceitamos JSON também (mais fácil de testar com curl).
//
// Schema permissivo: extraímos só o que importa. Campos extras ficam em
// `raw` para registro.
// ---------------------------------------------------------------------------
const webhookSchema = z.object({
  leads: z
    .object({
      add: z.array(z.object({ id: z.coerce.number() })).optional(),
      update: z.array(z.object({ id: z.coerce.number() })).optional(),
      status: z.array(z.object({ id: z.coerce.number() })).optional(),
    })
    .optional(),
  // Fallback para testes locais: { leadId, message }
  leadId: z.coerce.number().optional(),
  message: z.string().optional(),
});

function extractLeadId(parsed: z.infer<typeof webhookSchema>): number | null {
  if (parsed.leadId) return parsed.leadId;
  const candidates = [
    parsed.leads?.add?.[0]?.id,
    parsed.leads?.update?.[0]?.id,
    parsed.leads?.status?.[0]?.id,
  ];
  return candidates.find((v): v is number => typeof v === 'number') ?? null;
}

function extractHumanMessage(parsed: z.infer<typeof webhookSchema>, leadId: number): string {
  // Em produção, aqui você buscaria a última mensagem/nota do lead via
  // KommoService.getLead. Para o MVP, usamos o `message` opcional do
  // payload de teste — ou um texto sintético baseado no evento.
  if (parsed.message) return parsed.message;
  return `Webhook recebido para lead ${leadId}. Analise e tome a melhor ação.`;
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
    title: `Payload recebido do Kommo (Lead ID ${leadId})`,
    payload: req.body as object,
  });

  // 3. ACK imediato — fundamental pra Kommo não retentar.
  res.status(200).json({ ok: true, traceId: trace.id });

  // 4. Processamento em background. Note o `.catch` — se algo aqui
  //    explodir e ninguém capturar, o Node 24 dispara unhandledRejection.
  void processAgent({
    leadId,
    traceId: trace.id,
    humanMessage: extractHumanMessage(parsed.data, leadId),
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
  requestStart: number;
}): Promise<void> {
  const { leadId, traceId, humanMessage, requestStart } = args;
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
