import crypto from 'node:crypto';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { Prisma } from '@prisma/client';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { calculateCost, resolveOpenAIApiKey, recordLlmCall } from './openai.service.js';
import {
  avaliabilidadeDaConversa,
  custoComFallback,
  escolherJuiz,
  esforcoDoJuiz,
  interpretarSaidaDoJuiz,
  montarPedidoAnthropic,
  respostaCortada,
  textoDaResposta,
  type EscolhaDoJuiz,
  type MotivoNaoAvaliavel,
} from '../lib/juiz-da-ia.js';

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

export function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 16);
}

export function buildJudgePrompt(
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

/** O que o juiz recebeu do modelo, no formato comum aos dois provedores. */
export interface RespostaDoModelo {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** `stop_reason` da Anthropic (`refusal`/`max_tokens` cortam o JSON); a openai não informa aqui. */
  stopReason?: string | null;
  /** Corpo cru, para o `llm_calls`. */
  raw: unknown;
}

/**
 * Pontos de contato com o mundo (banco e modelo). O padrão usa prisma e os clientes de verdade; os testes
 * trocam por falsos, sem rede e sem banco.
 */
export interface DependenciasDoJuiz {
  avaliacaoExiste(conversationId: string): Promise<boolean>;
  /** Com o `meta`: é ele que diz se um `assistant` foi a Sofia, a equipe ou uma automação. */
  carregarMensagens(conversationId: string): Promise<Array<{ role: string; content: string; meta?: unknown }> | null>;
  chamarModelo(escolha: EscolhaDoJuiz, system: string, user: string, unit: Unit): Promise<RespostaDoModelo>;
  /** `substituir`: troca a avaliação que já existe (botão "reavaliar") em vez de criar uma. */
  gravarAvaliacao(data: Prisma.ConversationEvaluationUncheckedCreateInput, substituir?: boolean): Promise<void>;
  registrarChamada(p: Parameters<typeof recordLlmCall>[0]): void;
}

interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** O juiz de sempre: gpt-4o-mini (ou `JUDGE_MODEL`), `json_object`, temperatura 0. Não mudou. */
async function chamarOpenAI(escolha: EscolhaDoJuiz, system: string, user: string, unit: Unit): Promise<RespostaDoModelo> {
  const judge = new ChatOpenAI({
    apiKey: resolveOpenAIApiKey(unit),
    model: escolha.modelo,
    temperature: 0,
    modelKwargs: { response_format: { type: 'json_object' } },
  });
  const captured: { usage: TokenUsage | null; response: unknown } = { usage: null, response: null };
  const aiMsg = (await judge.invoke([new SystemMessage(system), new HumanMessage(user)], {
    callbacks: [
      {
        handleLLMEnd: (output: { llmOutput?: { tokenUsage?: TokenUsage } }) => {
          captured.usage = output.llmOutput?.tokenUsage ?? null;
          captured.response = output;
        },
      },
    ],
  })) as AIMessage;
  return {
    text: typeof aiMsg.content === 'string' ? aiMsg.content : JSON.stringify(aiMsg.content),
    promptTokens: captured.usage?.promptTokens ?? 0,
    completionTokens: captured.usage?.completionTokens ?? 0,
    raw: captured.response,
  };
}

/**
 * Haiku 5.5 pela Messages API com saída estruturada (`output_config.format`). O corpo vem de
 * `montarPedidoAnthropic` — o mesmo que irá no `params` de um item do Batch. O LangChain só transporta:
 * `thinking` e `outputConfig` seguem direto para o payload (`@langchain/anthropic` 1.3.29). Sem `temperature`.
 */
async function chamarAnthropic(escolha: EscolhaDoJuiz, system: string, user: string): Promise<RespostaDoModelo> {
  const pedido = montarPedidoAnthropic({ modelo: escolha.modelo, system, user, esforco: esforcoDoJuiz(process.env) });
  const judge = new ChatAnthropic({
    apiKey: escolha.apiKeyAnthropic ?? '',
    model: pedido.model,
    maxTokens: pedido.max_tokens,
    maxRetries: 2,
    clientOptions: { timeout: 60_000 },
    thinking: pedido.thinking,
    outputConfig: pedido.output_config,
  });
  const aiMsg = await judge.invoke([new SystemMessage(pedido.system), new HumanMessage(pedido.messages[0].content)]);
  const uso = (aiMsg as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
  const meta = (aiMsg as { response_metadata?: { stop_reason?: string | null } }).response_metadata;
  return {
    text: textoDaResposta(aiMsg.content),
    promptTokens: uso?.input_tokens ?? 0,
    completionTokens: uso?.output_tokens ?? 0,
    stopReason: meta?.stop_reason ?? null,
    raw: { content: aiMsg.content, usage: uso, stop_reason: meta?.stop_reason ?? null },
  };
}

/**
 * Argumentos do `upsert` do "reavaliar". O `update` leva `createdAt` NOVO: sozinho ele não é tocado, e uma
 * reavaliação que ficasse com a data da avaliação velha sairia da janela do painel de prompts (90 d,
 * `prompts.controller`) e da contagem de 24 h do diagnóstico (`diagnostics.service`). Vale também com as
 * chaves do juiz novo desligadas.
 */
export function argumentosDoUpsert(
  data: Prisma.ConversationEvaluationUncheckedCreateInput,
  agora: Date = new Date(),
): Prisma.ConversationEvaluationUpsertArgs {
  const { conversationId, ...resto } = data;
  return { where: { conversationId }, create: data, update: { ...resto, createdAt: agora } };
}

const dependenciasPadrao: DependenciasDoJuiz = {
  async avaliacaoExiste(conversationId) {
    const existing = await prisma.conversationEvaluation.findUnique({ where: { conversationId }, select: { id: true } });
    return !!existing;
  },
  async carregarMensagens(conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conv) return null;
    return conv.messages.map((m) => ({ role: m.role, content: m.content, meta: m.meta }));
  },
  chamarModelo: (escolha, system, user, unit) =>
    escolha.provedor === 'anthropic' ? chamarAnthropic(escolha, system, user) : chamarOpenAI(escolha, system, user, unit),
  async gravarAvaliacao(data, substituir) {
    if (substituir) {
      await prisma.conversationEvaluation.upsert(argumentosDoUpsert(data));
      return;
    }
    await prisma.conversationEvaluation.create({ data });
  },
  registrarChamada: (p) => void recordLlmCall(p),
};

export type DesfechoDoJuiz =
  | { status: 'avaliada'; resultado: JudgeResult }
  | { status: 'ja_existe' }
  | { status: 'sem_conversa' }
  | { status: 'sem_mensagens' }
  /** Pré-filtro (`JUDGE_SO_AVALIAVEIS=1`): não chamou o modelo e NÃO gravou linha. */
  | { status: 'nao_avaliavel'; motivo: MotivoNaoAvaliavel }
  /** `resposta_invalida` só ocorre no provedor anthropic (leitura estrita): sem linha, a próxima varredura repete. */
  | { status: 'erro'; motivo: 'resposta_invalida' | 'falha_na_chamada' | 'falha_ao_gravar' };

/**
 * Julga uma conversa e diz o que aconteceu. `judgeConversation` (abaixo) é o mesmo caminho devolvendo só o
 * resultado — a assinatura que o webhook e o worker já usam.
 *
 * Chaves (todas com padrão = comportamento de antes):
 *   JUDGE_PROVIDER=openai|anthropic   quem julga (padrão openai/gpt-4o-mini)
 *   JUDGE_SO_AVALIAVEIS=1             pula conversa que não dá para avaliar (padrão desligado)
 */
export async function julgarConversa(
  params: { conversationId: string; unit: Unit; substituir?: boolean },
  deps: DependenciasDoJuiz = dependenciasPadrao,
): Promise<DesfechoDoJuiz> {
  const { conversationId, unit, substituir = false } = params;

  if (!substituir && (await deps.avaliacaoExiste(conversationId))) {
    logger.info({ conversationId }, 'judge: avaliação já existe, pulando');
    return { status: 'ja_existe' };
  }

  const transcript = await deps.carregarMensagens(conversationId);
  if (!transcript) {
    logger.warn({ conversationId }, 'judge: conversation não encontrada');
    return { status: 'sem_conversa' };
  }
  if (transcript.length === 0) {
    logger.warn({ conversationId }, 'judge: conversation sem mensagens, pulando');
    return { status: 'sem_mensagens' };
  }

  if (process.env.JUDGE_SO_AVALIAVEIS === '1') {
    const a = avaliabilidadeDaConversa(transcript, { minFalasReais: Number(process.env.JUDGE_MIN_PATIENT_MSGS) || 2 });
    if (!a.avaliavel) {
      logger.info(
        { conversationId, motivo: a.motivo, falasReais: a.falasReais, falasDaIa: a.falasDaIa, falasDaEquipe: a.falasDaEquipe },
        'judge: conversa não avaliável, sem nota',
      );
      return { status: 'nao_avaliavel', motivo: a.motivo };
    }
  }

  const escolha = escolherJuiz(process.env, unit);
  if (escolha.motivoDoFallback) {
    logger.warn({ conversationId, unit: unit.slug }, `judge: ${escolha.motivoDoFallback} — usando openai`);
  }
  const { provedor, modelo } = escolha;

  const systemPrompt = unit.systemPrompt || '(prompt vazio)';
  const promptHash = hashPrompt(systemPrompt);
  const { system, user } = buildJudgePrompt(systemPrompt, transcript);
  const endpoint = 'chat.completions' as const;
  // Só o provedor novo se identifica no llm_calls; o antigo segue sem o campo (o padrão da tabela é 'openai').
  const marcaDoProvedor = provedor === 'anthropic' ? { provider: provedor } : {};
  const t0 = performance.now();
  let gravando = false;

  try {
    const resposta = await deps.chamarModelo(escolha, system, user, unit);
    const latencyMs = Math.round(performance.now() - t0);

    // openai: leitor antigo, que tolera JSON ruim (nota 0). anthropic: leitura estrita — JSON ruim é erro, sem linha.
    const parsed =
      provedor === 'anthropic'
        ? respostaCortada(resposta.stopReason)
          ? null
          : interpretarSaidaDoJuiz(resposta.text)
        : parseJudgeOutput(resposta.text);

    const { promptTokens, completionTokens } = resposta;
    const costUsd = custoComFallback(modelo, calculateCost(modelo, promptTokens, completionTokens), promptTokens, completionTokens);

    if (!parsed) {
      logger.error(
        { conversationId, modelo, stopReason: resposta.stopReason ?? null, inicio: resposta.text.slice(0, 200) },
        'judge: resposta fora do formato — sem avaliação gravada, a próxima varredura tenta de novo',
      );
      deps.registrarChamada({
        unitId: unit.id,
        traceId: null,
        ...marcaDoProvedor,
        model: modelo,
        endpoint,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        latencyMs,
        status: 'error',
        errorMessage: 'resposta_invalida',
        requestBody: { judge: true, conversationId, promptHash },
        responseBody: resposta.raw,
      });
      return { status: 'erro', motivo: 'resposta_invalida' };
    }

    const overall = averageScore(parsed.scores);

    deps.registrarChamada({
      unitId: unit.id,
      traceId: null,
      ...marcaDoProvedor,
      model: modelo,
      endpoint,
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
      responseBody: resposta.raw,
    });

    gravando = true;
    await deps.gravarAvaliacao({
      conversationId,
      unitId: unit.id,
      promptHash,
      promptSnapshot: systemPrompt,
      model: modelo,
      scores: parsed.scores as unknown as Prisma.InputJsonValue,
      overallScore: overall,
      verdict: parsed.verdict,
      costUsd: new Prisma.Decimal(costUsd),
      latencyMs,
    }, substituir);

    logger.info({ conversationId, promptHash, overall, costUsd, provedor, modelo }, 'judge: avaliação criada');

    return { status: 'avaliada', resultado: { scores: parsed.scores, overallScore: overall, verdict: parsed.verdict } };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, conversationId }, 'judge: falhou');
    deps.registrarChamada({
      unitId: unit.id,
      traceId: null,
      ...marcaDoProvedor,
      model: modelo,
      endpoint,
      latencyMs,
      status: 'error',
      errorMessage: msg,
      requestBody: { judge: true, conversationId, promptHash },
    });
    // Falha do banco (ou a corrida webhook × varredura no `create`) não é falha do modelo: o worker não conta
    // tentativa nem põe a conversa de molho — na próxima varredura ela já aparece avaliada, ou tenta de novo.
    return { status: 'erro', motivo: gravando ? 'falha_ao_gravar' : 'falha_na_chamada' };
  }
}

export async function judgeConversation(
  params: { conversationId: string; unit: Unit },
  deps?: DependenciasDoJuiz,
): Promise<JudgeResult | null> {
  const d = await julgarConversa(params, deps);
  return d.status === 'avaliada' ? d.resultado : null;
}

/** Leitor do provedor openai — INALTERADO: JSON quebrado vira nota 0 e "(sem veredito)". */
export function parseJudgeOutput(raw: string): { scores: CriterionScores; verdict: string } {
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

export const JUDGE_CRITERIA = CRITERIA.map((c) => ({ key: c.key, label: c.label, desc: c.desc }));
