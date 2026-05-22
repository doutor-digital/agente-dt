// ============================================================================
// lead-memory.service.ts — Memória de longo prazo por lead.
//
// LÓGICA DE ENGENHARIA
// --------------------
// O agente esquece tudo entre conversas/sessões — o checkpoint do LangGraph
// guarda só os turnos da conversa atual (e ainda assim por thread_id, que
// pode estourar limite de tokens em conversas longas).
//
// Esta camada resolve isso GUARDANDO:
//   1. `summary` — parágrafo curto sobre o paciente (≤ 600 chars)
//   2. `facts`   — chave→valor estruturado (idade, queixa, preferências…)
//
// LEITURA: barata. 1 SELECT por (unitId, leadId) com índice único. Plumbed
// no `composeSystemPromptForUnit` que já é await/Promise.all dos blocos.
//
// ESCRITA: NUNCA bloqueia a resposta ao paciente. Chamada via
// `scheduleLeadMemoryUpdate(...)` que dispara em background DEPOIS da resposta
// ter saído. Throttle interno: só roda o LLM-mini de N em N turnos pra não
// torrar dinheiro em conversas longas.
//
// CUSTO POR TURNO (esperado, gpt-4o-mini):
//   - 0 turnos: $0 (não dispara)
//   - 1 disparo a cada 4 turnos: ~500 input + ~250 output ≈ 0.000$ — desprezível
// ============================================================================

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { LeadMemory, Unit } from '@prisma/client';
import { createChatOpenAI, invokeChatModel } from './openai.service.js';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';

/** Dispara o updater a cada N turnos. Conservador: balancear custo × frescor. */
const UPDATE_EVERY_N_TURNS = 4;
/** Cap de chars do summary salvo. Prompt curto = barato e estável. */
const SUMMARY_MAX_CHARS = 600;
/** Modelo barato; o updater não precisa do raciocínio do modelo principal. */
const SUMMARIZER_MODEL_FALLBACK = 'gpt-4o-mini';

export interface LeadMemoryFacts {
  [key: string]: string | number | boolean | null;
}

export async function getLeadMemory(
  unitId: string,
  leadId: string | number,
): Promise<LeadMemory | null> {
  return prisma.leadMemory.findUnique({
    where: { unitId_leadId: { unitId, leadId: String(leadId) } },
  });
}

/**
 * Incrementa turnsSinceUpdate atomicamente. Garante que o counter cresce mesmo
 * se o updater não rodar nesse turno (ex: throttle).
 *
 * Idempotente em relação ao registro: usa upsert.
 */
export async function bumpLeadMemoryTurn(
  unitId: string,
  leadId: string | number,
): Promise<LeadMemory> {
  const id = String(leadId);
  // upsert + increment numa só operação.
  return prisma.leadMemory.upsert({
    where: { unitId_leadId: { unitId, leadId: id } },
    create: { unitId, leadId: id, summary: '', facts: {}, turnsSinceUpdate: 1 },
    update: { turnsSinceUpdate: { increment: 1 } },
  });
}

/**
 * Agenda atualização em background da memória do lead.
 *
 * NÃO retorna promise — fire-and-forget mesmo. O caller (webhook controller)
 * pode chamar isso APÓS já ter enviado a resposta ao paciente e seguir.
 *
 * Decide internamente se vai rodar o LLM ou só bumpa o contador:
 *   - 1ª vez (sem memória) → roda
 *   - turnsSinceUpdate >= UPDATE_EVERY_N_TURNS → roda
 *   - senão → só bumpa contador
 */
export function scheduleLeadMemoryUpdate(args: {
  unit: Unit;
  leadId: number;
  /** Mensagens do turno atual (lead + IA) — texto puro. */
  recentTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
}): void {
  void runLeadMemoryUpdate(args).catch((err) => {
    logger.warn(
      { err, unitSlug: args.unit.slug, leadId: args.leadId },
      'leadMemory updater falhou (silencioso)',
    );
  });
}

async function runLeadMemoryUpdate(args: {
  unit: Unit;
  leadId: number;
  recentTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<void> {
  const { unit, leadId, recentTurns } = args;
  const idStr = String(leadId);

  // 1) Bump atômico — sempre roda, registra a passagem do turno.
  const after = await bumpLeadMemoryTurn(unit.id, leadId);

  const hasNoSummaryYet = !after.summary || after.summary.length === 0;
  const dueByThrottle = after.turnsSinceUpdate >= UPDATE_EVERY_N_TURNS;
  if (!hasNoSummaryYet && !dueByThrottle) {
    // Throttle: este turno só conta, não chama LLM.
    return;
  }
  if (recentTurns.length === 0) return;

  // 2) Pega memória atual + ÚLTIMAS N mensagens da conversa pra dar contexto
  //    suficiente sem inflar o prompt do summarizer.
  const conv = await prisma.conversation.findUnique({
    where: { unitId_leadId: { unitId: unit.id, leadId: idStr } },
    select: { id: true },
  });
  let history: Array<{ role: string; content: string }> = [];
  if (conv) {
    const rows = await prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { role: true, content: true },
    });
    history = rows.reverse();
  } else {
    history = recentTurns;
  }

  // 3) Monta o prompt do summarizer.
  const factsCurrent = (after.facts as LeadMemoryFacts) ?? {};
  const sysPrompt = [
    'Você é um assistente de CRM que mantém memória de longo prazo dos pacientes.',
    'A cada N turnos recebe a memória atual + as últimas mensagens da conversa.',
    'Sua tarefa: devolver memória ATUALIZADA em JSON estrito (sem markdown).',
    '',
    'FORMATO DE SAÍDA (JSON puro):',
    '{',
    `  "summary": "Parágrafo único, ≤ ${SUMMARY_MAX_CHARS} chars, em português, descrevendo quem é o paciente, queixa principal, preferências, etapa da jornada.",`,
    '  "facts":   { "chave_snake_case": "valor curto", ... }',
    '}',
    '',
    'REGRAS:',
    '- NÃO invente dados. Só registre o que está EXPLÍCITO na conversa.',
    '- Em conflito com memória anterior, prefira a informação MAIS RECENTE.',
    '- Mantenha facts enxuto (≤ 12 chaves). Remova chaves obsoletas.',
    '- Use snake_case nas chaves. Valores curtos (palavras-chave).',
    '- summary deve caber em ≤ 600 chars. Sem floreio.',
    '- Se NADA mudou substancialmente, devolva summary/facts iguais à entrada.',
    '- Saída deve ser JSON parseável puro — nada de ```json, sem comentários.',
  ].join('\n');

  const userPrompt = [
    '# MEMÓRIA ATUAL',
    `summary: ${after.summary || '(vazio)'}`,
    `facts: ${JSON.stringify(factsCurrent)}`,
    '',
    '# ÚLTIMAS MENSAGENS DESTA CONVERSA',
    history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n'),
    '',
    'Devolva agora a memória atualizada em JSON.',
  ].join('\n');

  // 4) Roda o LLM mini. Conservador no maxTokens — saída sempre cabe.
  try {
    const model = createChatOpenAI(unit, {
      model: unit.openaiModel?.includes('mini') ? unit.openaiModel : SUMMARIZER_MODEL_FALLBACK,
      temperature: 0.1,
      maxTokens: 700,
    });
    const ai = (await invokeChatModel({
      model: model as unknown as Parameters<typeof invokeChatModel>[0]['model'],
      messages: [new SystemMessage(sysPrompt), new HumanMessage(userPrompt)],
      unitId: unit.id,
      traceId: null,
      modelName: model.model,
    })) as AIMessage;
    const text = typeof ai.content === 'string' ? ai.content : JSON.stringify(ai.content);
    const cleaned = stripJsonFence(text).trim();
    let parsed: { summary?: string; facts?: LeadMemoryFacts } | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      logger.warn(
        { unit: unit.slug, leadId, sample: cleaned.slice(0, 200) },
        'leadMemory: saída do summarizer não é JSON válido — ignorando este ciclo',
      );
      return;
    }
    if (!parsed) return;

    const newSummary = sanitizeSummary(parsed.summary);
    const newFacts = sanitizeFacts(parsed.facts);

    await prisma.leadMemory.update({
      where: { unitId_leadId: { unitId: unit.id, leadId: idStr } },
      data: {
        summary: newSummary,
        facts: newFacts as unknown as object,
        turnsSinceUpdate: 0,
        lastSummarizedAt: new Date(),
      },
    });
    logger.info(
      { unit: unit.slug, leadId, summaryLen: newSummary.length, factsCount: Object.keys(newFacts).length },
      'leadMemory: atualizada',
    );
  } catch (err) {
    logger.warn({ err, unit: unit.slug, leadId }, 'leadMemory: erro do LLM (ignorado)');
  }
}

function stripJsonFence(s: string): string {
  // Remove ```json ... ``` se algum modelo desobediente envolver.
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
}

function sanitizeSummary(s: unknown): string {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim();
  return trimmed.length > SUMMARY_MAX_CHARS ? trimmed.slice(0, SUMMARY_MAX_CHARS) : trimmed;
}

function sanitizeFacts(f: unknown): LeadMemoryFacts {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return {};
  const out: LeadMemoryFacts = {};
  let count = 0;
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    if (count >= 12) break;
    if (typeof k !== 'string' || k.length === 0 || k.length > 60) continue;
    if (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      v === null
    ) {
      const safeV =
        typeof v === 'string' && v.length > 200 ? v.slice(0, 200) : (v as string | number | boolean | null);
      out[k] = safeV;
      count++;
    }
  }
  return out;
}
