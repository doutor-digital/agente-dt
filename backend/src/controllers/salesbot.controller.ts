import type { Request, Response } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildAgentGraph, buildThreadId } from '../agent/graph.js';
import { TraceRecorder } from '../agent/trace-recorder.js';
import { findUnitBySlug, ensureDefaultUnit } from '../services/units.service.js';
import { addMessage, upsertConversation } from '../services/conversations.service.js';
import { createKommoClient, isLeadPaused } from '../services/kommo.service.js';
import { leadPausadoPorJanela } from '../lib/pausa-lead.js';
import { garantirTituloPadrao } from '../lib/titulo-padrao.js';
import { blocoDaConversaOficial } from '../lib/conversa-oficial.js';

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

const extractMessage = (p: Payload) => (p.message || p.text || '').trim() || null;
const extractLeadId = (p: Payload) => p.lead_id || p.leadId || null;
const extractContactName = (p: Payload) => p.contact_name || p.contactName || null;

function currentTimeTag(): string {
  const utc = new Date();
  const araguaina = new Date(utc.getTime() - 3 * 60 * 60 * 1000);
  const h = String(araguaina.getUTCHours()).padStart(2, '0');
  const m = String(araguaina.getUTCMinutes()).padStart(2, '0');
  return `[HORA: ${h}:${m}]`;
}

async function resolveUnit(req: Request): Promise<Unit | null> {
  const slug = req.params.unitSlug ? String(req.params.unitSlug) : '';
  if (slug) return findUnitBySlug(slug);
  return ensureDefaultUnit();
}

export async function handleSalesbotWebhook(req: Request, res: Response): Promise<void> {
  const requestStart = performance.now();

  const unit = await resolveUnit(req);
  if (!unit) {
    res.status(404).json({ ok: false, error: 'unit_not_found', reply: 'Erro técnico, tente em instantes.' });
    return;
  }

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ errors: parsed.error.flatten(), body: req.body }, 'salesbot payload inválido');
    res.status(400).json({ ok: false, error: 'invalid_payload', reply: 'Erro técnico, tente em instantes.' });
    return;
  }

  const message = extractMessage(parsed.data);
  const leadId = extractLeadId(parsed.data);
  const contactName = extractContactName(parsed.data);
  const phone = parsed.data.phone ?? null;

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

  const trace = await prisma.executionTrace.create({
    data: {
      unitId: unit.id,
      threadId: buildThreadId(unit.slug, leadId),
      leadId,
      channel: 'salesbot',
      input: req.body as object,
      status: 'RUNNING',
    },
  });

  const recorder = new TraceRecorder(trace.id, unit.id);
  await recorder.step({
    kind: 'WEBHOOK_RECEIVED',
    title: contactName ? `Mensagem de ${contactName} (Lead ${leadId})` : `Mensagem do Lead ${leadId}`,
    payload: req.body as object,
  });

  const conv = await upsertConversation({
    unitId: unit.id,
    leadId,
    contactName,
    phone,
    channel: 'salesbot',
  });
  // caminho do Salesbot também não passa pelo webhook: lead sem nome ganha "Lead dd/mm/aaaa" por aqui (TITULO_PADRAO_SLUGS)
  if (Number.isFinite(Number(leadId))) {
    void garantirTituloPadrao(unit, createKommoClient(unit), Number(leadId)).catch((err) =>
      logger.warn({ err: String(err), leadId, unit: unit.slug }, 'titulo-padrao: falha ao renomear o lead (salesbot)'),
    );
  }
  await addMessage({
    conversationId: conv.id,
    traceId: trace.id,
    role: 'user',
    content: message,
  });

  if ((await isLeadPaused(unit, Number(leadId))) || (await leadPausadoPorJanela(unit.id, Number(leadId)))) {
    const totalLatency = Math.round(performance.now() - requestStart);
    await recorder.step({
      kind: 'COMPLETED',
      title: 'IA pausada por humano — resposta omitida',
      payload: { leadId, reason: 'kommo_paused_field_checked' },
      latencyMs: totalLatency,
    });
    await recorder.finalize({
      status: 'SUCCESS',
      latencyMs: totalLatency,
      iaDecision: '__paused__',
    });
    res.json({ ok: true, paused: true, reply: '', traceId: trace.id, unit: unit.slug });
    return;
  }

  const humanMessage = `${currentTimeTag()} ${message}`;

  try {
    const graph = await buildAgentGraph(recorder, unit, Number(leadId));
    const threadId = buildThreadId(unit.slug, leadId);

    // A conversa como o WhatsApp a vê (rota oficial): a resposta da SDR e a mensagem do
    // paciente que este caminho não trouxe.
    //
    // ISTO SÓ EXISTIA NO WEBHOOK, e o salesbot é por onde falam 16 unidades — Serra, Bebedouro,
    // Rio Verde, Boa Vista, Taubaté e mais. Enquanto ficou de fora, a Sofia respondia sem ver o
    // que a SDR já havia combinado. Foi o que aconteceu com o lead 22828271 da Serra em
    // 25/09/2026: a SDR atendeu e marcou, a Sofia viu cinco mensagens do paciente sem nenhuma
    // resposta, e quando ele pediu a chave Pix ela disse "vou confirmar com a equipe" — com a
    // chave correta no prompt e a ficha proibindo essa frase com todas as letras. Ela não
    // confiava no próprio contexto porque o contexto estava furado.
    //
    // Passamos `message` cru, e não `humanMessage`: o dedupe compara o texto com o que está no
    // Kommo, e a etiqueta de hora no começo faria a linha nunca casar.
    //
    // Custo: o bloco volta vazio quando não há nada novo desde a última fala dela, e quando vem
    // entra no HumanMessage — cauda dinâmica, não estoura o prefixo em cache. Uma falha aqui
    // nunca segura o atendimento.
    const blocoOficial = await blocoDaConversaOficial({
      unit,
      leadId: Number(leadId),
      humanMessage: message,
      recorder,
    }).catch((err) => {
      logger.warn(
        { err: String(err), leadId, unit: unit.slug },
        'conversa oficial (salesbot): falha ao ler (segue sem)',
      );
      return '';
    });
    const entradaDoModelo = blocoOficial ? `${blocoOficial}\n\n${humanMessage}` : humanMessage;

    const result = await graph.invoke(
      {
        leadId: Number(leadId),
        traceId: trace.id,
        messages: [new HumanMessage(entradaDoModelo)],
      },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 24,
      },
    );

    const reply =
      (result.decision ?? '').trim() ||
      'Recebi sua mensagem, tô só verificando com a equipe um instante 🙏';
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

    await addMessage({
      conversationId: conv.id,
      traceId: trace.id,
      role: 'assistant',
      content: reply,
      meta: { via: 'salesbot' },
    });

    res.json({ ok: true, reply, traceId: trace.id, unit: unit.slug });
    logger.info({ traceId: trace.id, leadId, ms: totalLatency, unit: unit.slug }, 'salesbot concluído');
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
    logger.error({ err, traceId: trace.id, leadId, unit: unit.slug }, 'salesbot falhou');

    res.status(200).json({
      ok: false,
      reply: 'Recebi sua mensagem 💚 Vou pedir pra Maria Eduarda te atender de manhã, tá?',
      traceId: trace.id,
      error: msg,
    });
  }
}
