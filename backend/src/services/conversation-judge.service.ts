// ============================================================================
// conversation-judge.service.ts — LLM-as-judge das conversas convertidas.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Quando um lead entra numa etapa de "Ganho" do Kommo, queremos saber se
// foi MÉRITO do prompt da IA — e se foi, *como* o prompt se saiu nessa
// conversa específica. Essa service materializa essa pergunta:
//
//   1. Lê todas as Messages da Conversation (user + assistant em ordem).
//   2. Resolve qual `systemPrompt` da Unit estava ATIVO no momento da
//      conversão. (Usamos o `Unit.systemPrompt` atual — não temos histórico
//      explícito; se isso virar gargalo, adicionar versionamento via AgentConfig.)
//   3. Monta um prompt de avaliação estruturado que pede 5 critérios
//      pontuados 0-10 + um veredito qualitativo curto.
//   4. Chama `gpt-4o-mini` com response_format=json_object e parseia.
//   5. Grava ConversationEvaluation (unique por conversationId → idempotente).
//
// `promptHash` é sha256 hex do systemPrompt no momento — chave de
// agrupamento do painel ("este prompt converteu N leads, score médio X").
//
// IDEMPOTÊNCIA
// ------------
// Se já existe uma ConversationEvaluation pra aquela conversa, NÃO re-roda
// (custa dinheiro). Pra forçar nova avaliação, deletar a row antiga.
//
// FAIL-SOFT
// ---------
// Toda a observabilidade (custo, latência) é gravada via LlmCall — mesmo
// quando o juiz falha. A exceção do juiz é logada mas NÃO sobe pro caller
// (o webhook do Kommo é quem chama isso em background).
// ============================================================================

import crypto from 'node:crypto';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { Prisma } from '@prisma/client';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { calculateCost, resolveOpenAIApiKey, recordLlmCall } from './openai.service.js';

// Modelo padrão do juiz — pode ser sobrescrito por env JUDGE_MODEL.
// Pro MVP, gpt-4o-mini é equilíbrio bom: bom o suficiente pra crítica
// textual estruturada, custo ~$0.15/$0.6 por M tokens.
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'gpt-4o-mini';

// Critérios do juiz. Adicionar/remover aqui propaga pra UI via API
// (frontend lê as keys do scores).
const CRITERIA = [
  { key: 'clareza',   label: 'Clareza',                   desc: 'Mensagens objetivas, sem ambiguidade, jargão controlado.' },
  { key: 'empatia',   label: 'Empatia',                   desc: 'Reconhece a dor/contexto do paciente, valida sentimentos.' },
  { key: 'objecoes',  label: 'Tratamento de objeções',    desc: 'Identifica e responde a hesitações (preço, tempo, confiança).' },
  { key: 'cta',       label: 'Chamada pra ação',          desc: 'Conduz a próximos passos concretos (agendar, confirmar, etc).' },
  { key: 'tom',       label: 'Tom comercial',             desc: 'Profissional, humano, alinhado ao posicionamento da clínica.' },
] as const;

export type CriterionKey = (typeof CRITERIA)[number]['key'];

export interface CriterionScores {
  clareza: number;
  empatia: number;
  objecoes: number;
  cta: number;
  tom: number;
}

export interface JudgeResult {
  scores: CriterionScores;
  overallScore: number;
  verdict: string;
}

// ---------------------------------------------------------------------------
// Hash do prompt — chave de agrupamento. Curto pra logs/URLs.
// ---------------------------------------------------------------------------

export function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Monta o prompt do juiz.
// ---------------------------------------------------------------------------

function buildJudgePrompt(
  systemPrompt: string,
  transcript: Array<{ role: string; content: string }>,
): { system: string; user: string } {
  const criteriaList = CRITERIA.map(
    (c) => `- **${c.key}** (${c.label}): ${c.desc}`,
  ).join('\n');

  const system = `Você é um avaliador especialista em vendas consultivas no segmento clínico/saúde.
Analise a conversa entre IA e paciente abaixo, considerando o "prompt operacional" que orientou a IA.
Pontue cada critério de 0 a 10 (0 = falhou, 10 = perfeito) e dê um veredito curto (3 a 5 frases) sobre o porquê esse lead foi convertido — ou apesar do quê.

Responda APENAS com JSON válido neste formato:
{
  "scores": { "clareza": number, "empatia": number, "objecoes": number, "cta": number, "tom": number },
  "verdict": "texto curto explicando o que funcionou e o que poderia melhorar"
}`;

  const transcriptText = transcript
    .map((m) => {
      const who = m.role === 'user' ? 'PACIENTE' : m.role === 'assistant' ? 'IA' : m.role.toUpperCase();
      return `${who}: ${m.content}`;
    })
    .join('\n\n');

  const user = `CRITÉRIOS:
${criteriaList}

PROMPT OPERACIONAL DA IA (system prompt no momento da conversão):
"""
${systemPrompt}
"""

CONVERSA (cronológica):
"""
${transcriptText}
"""`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// judgeConversation — entrada principal.
// ---------------------------------------------------------------------------

export async function judgeConversation(params: {
  conversationId: string;
  unit: Unit;
}): Promise<JudgeResult | null> {
  const { conversationId, unit } = params;

  // Idempotência — já avaliada?
  const existing = await prisma.conversationEvaluation.findUnique({
    where: { conversationId },
    select: { id: true },
  });
  if (existing) {
    logger.info({ conversationId }, 'judge: avaliação já existe, pulando');
    return null;
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conv) {
    logger.warn({ conversationId }, 'judge: conversation não encontrada');
    return null;
  }
  if (conv.messages.length === 0) {
    logger.warn({ conversationId }, 'judge: conversation sem mensagens, pulando');
    return null;
  }

  const transcript = conv.messages.map((m) => ({ role: m.role, content: m.content }));
  const systemPrompt = unit.systemPrompt || '(prompt vazio)';
  const promptHash = hashPrompt(systemPrompt);
  const { system, user } = buildJudgePrompt(systemPrompt, transcript);

  const apiKey = resolveOpenAIApiKey(unit);
  const judge = new ChatOpenAI({
    apiKey,
    model: JUDGE_MODEL,
    temperature: 0,
    modelKwargs: { response_format: { type: 'json_object' } },
  });

  interface TokenUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }
  const captured: { usage: TokenUsage | null; response: unknown } = { usage: null, response: null };
  const t0 = performance.now();

  try {
    const aiMsg = (await judge.invoke(
      [new SystemMessage(system), new HumanMessage(user)],
      {
        callbacks: [
          {
            handleLLMEnd: (output: { llmOutput?: { tokenUsage?: TokenUsage } }) => {
              captured.usage = output.llmOutput?.tokenUsage ?? null;
              captured.response = output;
            },
          },
        ],
      },
    )) as AIMessage;

    const latencyMs = Math.round(performance.now() - t0);
    const rawText = typeof aiMsg.content === 'string' ? aiMsg.content : JSON.stringify(aiMsg.content);
    const parsed = parseJudgeOutput(rawText);
    const overall = averageScore(parsed.scores);

    const promptTokens = captured.usage?.promptTokens ?? 0;
    const completionTokens = captured.usage?.completionTokens ?? 0;
    const costUsd = calculateCost(JUDGE_MODEL, promptTokens, completionTokens);

    // Grava LlmCall pra a chamada do juiz aparecer no painel "Chamadas IA".
    void recordLlmCall({
      unitId: unit.id,
      traceId: null,
      model: JUDGE_MODEL,
      endpoint: 'chat.completions',
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      latencyMs,
      status: 'success',
      requestBody: {
        judge: true,
        conversationId,
        promptHash,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user.length > 800 ? user.slice(0, 800) + '...[trunc]' : user },
        ],
      },
      responseBody: captured.response,
    });

    await prisma.conversationEvaluation.create({
      data: {
        conversationId,
        unitId: unit.id,
        promptHash,
        promptSnapshot: systemPrompt,
        model: JUDGE_MODEL,
        scores: parsed.scores as unknown as Prisma.InputJsonValue,
        overallScore: overall,
        verdict: parsed.verdict,
        costUsd: new Prisma.Decimal(costUsd),
        latencyMs,
      },
    });

    logger.info(
      { conversationId, promptHash, overall, costUsd },
      'judge: avaliação criada',
    );

    return { scores: parsed.scores, overallScore: overall, verdict: parsed.verdict };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, conversationId }, 'judge: falhou');
    void recordLlmCall({
      unitId: unit.id,
      traceId: null,
      model: JUDGE_MODEL,
      endpoint: 'chat.completions',
      latencyMs,
      status: 'error',
      errorMessage: msg,
      requestBody: { judge: true, conversationId, promptHash },
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parser defensivo — clamp em 0-10, default 0, verdict como string.
// ---------------------------------------------------------------------------

function parseJudgeOutput(raw: string): { scores: CriterionScores; verdict: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const obj = (parsed ?? {}) as { scores?: Record<string, unknown>; verdict?: unknown };
  const s = obj.scores ?? {};
  const clamp = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(10, n));
  };
  return {
    scores: {
      clareza: clamp(s.clareza),
      empatia: clamp(s.empatia),
      objecoes: clamp(s.objecoes),
      cta: clamp(s.cta),
      tom: clamp(s.tom),
    },
    verdict: typeof obj.verdict === 'string' ? obj.verdict.slice(0, 4000) : '(sem veredito)',
  };
}

function averageScore(s: CriterionScores): number {
  const vals = [s.clareza, s.empatia, s.objecoes, s.cta, s.tom];
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

// Exportado pra UI saber renderizar os critérios na mesma ordem do backend.
export const JUDGE_CRITERIA = CRITERIA.map((c) => ({ key: c.key, label: c.label, desc: c.desc }));
