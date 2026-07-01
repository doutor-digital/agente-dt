// ============================================================================
// openai.service.ts — Cliente OpenAI instrumentado.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Todo acesso à OpenAI nesta plataforma passa por aqui — incluindo o que o
// LangGraph faz dentro do node `agent`. Por quê?
//
//  1. CADA UNIDADE TEM SUA PRÓPRIA API KEY (e seu próprio assistant_id).
//     A `ChatOpenAI` do LangChain é uma instância — então criamos UM cliente
//     POR UNIDADE/INVOCAÇÃO, em vez de um global.
//
//  2. OBSERVABILIDADE TOTAL.
//     Toda chamada gera um registro em `LlmCall` com tokens, custo e
//     payload (request/response). É a base do painel "Chamadas IA".
//
//  3. PREÇOS ATUALIZADOS.
//     Mantemos uma tabela de preços ($/MTok) por modelo. O custo é calculado
//     em runtime com base no `usage` que a OpenAI devolve em cada response.
//     Atualizar preço = mudar essa tabela.
//
// Suportamos dois modos:
//   - Chat Completions (`chat.completions`) — modelo + system prompt + tools.
//     É o caminho do LangGraph + ChatOpenAI.bindTools.
//   - Assistants API (`assistants`) — cada Unit tem um assistant_id pré-criado
//     na plataforma da OpenAI. Útil quando a unidade quer ferramentas,
//     vector stores e conhecimento próprio gerenciados pelo painel da OpenAI
//     em vez de pelo nosso AgentConfig.
// ============================================================================

import { ChatOpenAI, type ChatOpenAICallOptions } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { Prisma } from '@prisma/client';
import type { Unit } from '@prisma/client';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';

// ---------------------------------------------------------------------------
// TABELA DE PREÇOS ($/1M tokens) — atualize conforme OpenAI mudar.
// Fonte: openai.com/pricing (snapshot 2026).
// Modelos não listados caem no preço 0 — o registro ainda é criado, só sem
// custo. Use o nome canônico (sem ":free", sem prefixos custom).
// ---------------------------------------------------------------------------

interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  // GPT-4 family
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-2024-11-20': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30 },
  'gpt-4': { inputPer1M: 30, outputPer1M: 60 },
  // GPT-5 (assumido similar ao 4o até divulgação oficial)
  'gpt-5-mini': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'gpt-5': { inputPer1M: 5, outputPer1M: 15 },
  // O-series
  'o1-mini': { inputPer1M: 3, outputPer1M: 12 },
  'o1': { inputPer1M: 15, outputPer1M: 60 },
  // Anthropic (Claude) — base input/output. Cache hit = 0.1x input, cache
  // write (TTL 1h) = 2x input; tratados em calculateCost via cache tokens.
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25 },
  'claude-sonnet-5': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5 },
};

export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  // Prompt caching (Anthropic): tokens lidos do cache custam 0.1x o input base;
  // tokens escritos no cache (TTL 1h) custam 2x. `promptTokens` é o TOTAL de
  // input (inclui cache read + write); o resto é input "cru" a preço cheio.
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  const uncached = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const inputCost =
    (uncached / 1_000_000) * price.inputPer1M +
    (cacheReadTokens / 1_000_000) * price.inputPer1M * 0.1 +
    (cacheWriteTokens / 1_000_000) * price.inputPer1M * 2;
  const outputCost = (completionTokens / 1_000_000) * price.outputPer1M;
  // 6 casas decimais para não perder centavos em chamadas baratas.
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Resolve a API key efetiva.
// Cada Unit pode ter sua própria openai_api_key. Se a Unit não tem uma
// (ex: unidade interna usando a key da plataforma), caímos pra env.
// ---------------------------------------------------------------------------

export function resolveOpenAIApiKey(unit: Pick<Unit, 'openaiApiKey'> | null): string {
  return unit?.openaiApiKey || env.OPENAI_API_KEY;
}

// ---------------------------------------------------------------------------
// Factory: ChatOpenAI por Unit.
// Devolve a instância ChatOpenAI configurada com a key/modelo da Unit.
// Esta é a entrada do LangGraph — tools são ligadas pelo caller via
// `.bindTools()`.
// ---------------------------------------------------------------------------

export interface ChatOpenAIOverrides {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

// Teto de tempo POR chamada à OpenAI. Acima disso, aborta.
// HISTÓRICO: o teto entrou em 5s (commit 5bcc7a5) achando que ~95% das chamadas
// ficavam abaixo de 5s. Os dados de produção provaram o contrário — o p95 REAL é
// ~7s. Resultado: o teto de 5s cortava no meio do tráfego normal, abortava chamadas
// que iam dar certo e refazia do zero (retry), DOBRANDO a latência das mais pesadas
// (p95 piorou de 6,9s → 8,4s) e gerando "Request timed out" onde o paciente ficava
// sem resposta. Subido para 15s: acima do p95 real (~7s) e do cluster de 8-11s, então
// só mata travamento genuíno (a cauda de 30s+ que motivou o teto original). 1 retry.
// Ajustável por env: OPENAI_TIMEOUT_MS / OPENAI_MAX_RETRIES (0 = fail-fast, sem retry).
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 15000;
const OPENAI_MAX_RETRIES = Number.isFinite(Number(process.env.OPENAI_MAX_RETRIES))
  ? Number(process.env.OPENAI_MAX_RETRIES)
  : 1;

export function createChatOpenAI(
  unit: Pick<
    Unit,
    | 'openaiApiKey'
    | 'openaiModel'
    | 'openaiTemperature'
    | 'openaiMaxTokens'
    | 'openaiTopP'
    | 'openaiFrequencyPenalty'
    | 'openaiPresencePenalty'
  > | null,
  overrides: ChatOpenAIOverrides = {},
): ChatOpenAI<ChatOpenAICallOptions> {
  return new ChatOpenAI({
    apiKey: resolveOpenAIApiKey(unit),
    model: overrides.model ?? unit?.openaiModel ?? env.OPENAI_MODEL,
    temperature: overrides.temperature ?? unit?.openaiTemperature ?? 0,
    maxTokens: overrides.maxTokens ?? unit?.openaiMaxTokens ?? 1024,
    topP: overrides.topP ?? unit?.openaiTopP ?? 1,
    frequencyPenalty: overrides.frequencyPenalty ?? unit?.openaiFrequencyPenalty ?? 0,
    presencePenalty: overrides.presencePenalty ?? unit?.openaiPresencePenalty ?? 0,
    // Teto de 5s por chamada — corta a cauda longa que inflava a latência média.
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
  });
}

// ---------------------------------------------------------------------------
// Factory por PROVEDOR — escolhe OpenAI ou Anthropic (Claude) pela Unit.
//
// `llmProvider="anthropic"` + `anthropicApiKey` → ChatAnthropic (ex: Opus 4.8).
// Opus 4.8 REJEITA temperature/top_p/penalties (400), então NÃO os passamos.
// Qualquer outra config → cai no ChatOpenAI de sempre (comportamento atual).
//
// O caller liga as tools via `.bindTools()` — ChatAnthropic tem a mesma
// interface. O system prompt com cache_control é montado no graph.ts.
// ---------------------------------------------------------------------------
export type ChatModel =
  | ChatOpenAI<ChatOpenAICallOptions>
  | ChatAnthropic;

export function createChatModel(
  unit: Unit | null,
  overrides: ChatOpenAIOverrides = {},
): ChatModel {
  if (unit?.llmProvider === 'anthropic' && unit.anthropicApiKey) {
    return new ChatAnthropic({
      apiKey: unit.anthropicApiKey,
      model: overrides.model ?? unit.anthropicModel ?? 'claude-opus-4-8',
      maxTokens: overrides.maxTokens ?? unit.openaiMaxTokens ?? 1024,
      // SEM temperature/topP/penalties — Opus 4.8 os rejeita.
      maxRetries: OPENAI_MAX_RETRIES,
    });
  }
  return createChatOpenAI(unit, overrides);
}

// ---------------------------------------------------------------------------
// LlmCall recorder — instrumentação fora do LangChain.
//
// Estratégia: o LangChain expõe callbacks (`callbacks: [...]`) com hooks
// `handleLLMEnd` e `handleLLMError`. Usamos isso pra capturar a resposta
// da OpenAI sem patchar o ChatOpenAI. O callback recebe o `LLMResult` com
// `llmOutput.tokenUsage` que a OpenAI devolve.
//
// Cada invocação cria UM LlmCall. Se a chamada quebrar, gravamos com
// status="error" pra o painel mostrar a falha.
// ---------------------------------------------------------------------------

export interface RecordLlmCallParams {
  unitId: string | null;
  traceId: string | null;
  provider?: string;
  model: string;
  endpoint?: 'chat.completions' | 'assistants';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  // Prompt caching (Anthropic) — pra custo correto: read = 0.1x, write = 2x.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs: number;
  status?: 'success' | 'error';
  errorMessage?: string;
  requestBody?: unknown;
  responseBody?: unknown;
}

export async function recordLlmCall(p: RecordLlmCallParams): Promise<void> {
  const promptTokens = p.promptTokens ?? 0;
  const completionTokens = p.completionTokens ?? 0;
  const totalTokens = p.totalTokens ?? promptTokens + completionTokens;
  const costUsd = calculateCost(
    p.model,
    promptTokens,
    completionTokens,
    p.cacheReadTokens ?? 0,
    p.cacheWriteTokens ?? 0,
  );

  try {
    await prisma.llmCall.create({
      data: {
        unitId: p.unitId,
        traceId: p.traceId,
        provider: p.provider ?? 'openai',
        model: p.model,
        endpoint: p.endpoint ?? 'chat.completions',
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd: new Prisma.Decimal(costUsd),
        latencyMs: p.latencyMs,
        status: p.status ?? 'success',
        errorMessage: p.errorMessage,
        requestBody: p.requestBody === undefined ? undefined : (p.requestBody as object),
        responseBody: p.responseBody === undefined ? undefined : (p.responseBody as object),
      },
    });
  } catch (err) {
    // Observabilidade não pode quebrar o agente.
    logger.error({ err }, 'falha ao gravar LlmCall');
  }
}

// ---------------------------------------------------------------------------
// invokeChatModel — wrapper que chama o ChatOpenAI e grava LlmCall.
//
// Usado pelo agent/graph dentro do node `agent`. A captura do `usage` é
// feita via callbacks do LangChain — `handleLLMEnd` recebe o LLMResult
// completo, com `llmOutput.tokenUsage`.
//
// Aceita o ChatOpenAI cru OU o Runnable retornado por `.bindTools(...)` —
// ambos expõem `.invoke(messages, opts)`.
// ---------------------------------------------------------------------------

interface InvokableModel {
  invoke: (
    messages: BaseMessage[],
    options?: { callbacks?: unknown[] },
  ) => Promise<unknown>;
}

interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// Formato do `usage_metadata` que o LangChain popula no AIMessage do Claude.
interface AnthropicUsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: { cache_read?: number; cache_creation?: number };
}

export interface InvokeChatModelArgs {
  model: InvokableModel;
  messages: BaseMessage[];
  unitId: string | null;
  traceId: string | null;
  modelName: string;
  /** "openai" (default) ou "anthropic" — grava no LlmCall. */
  provider?: string;
  // Para registrar o request body. Stringificar a lista de mensagens é caro
  // se a conversa é longa — passamos só os essenciais (role + content + tools).
  tools?: Pick<StructuredToolInterface, 'name'>[];
}

export async function invokeChatModel(args: InvokeChatModelArgs): Promise<unknown> {
  const t0 = performance.now();
  let usage: TokenUsage | null = null;
  let rawResponse: unknown = null;

  try {
    const response = await args.model.invoke(args.messages, {
      callbacks: [
        {
          handleLLMEnd: (output: { llmOutput?: { tokenUsage?: TokenUsage } }) => {
            usage = output.llmOutput?.tokenUsage ?? null;
            rawResponse = output;
          },
        },
      ],
    });
    const latencyMs = Math.round(performance.now() - t0);

    const finalUsage: TokenUsage = usage ?? {};
    // ChatOpenAI expõe usage via callback (`llmOutput.tokenUsage`). ChatAnthropic
    // NÃO — o usage vem no próprio AIMessage retornado (`usage_metadata`), que
    // ainda traz os tokens de cache. Fallback pra ele quando o callback não veio.
    let { promptTokens, completionTokens, totalTokens } = finalUsage;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const um = (response as { usage_metadata?: AnthropicUsageMetadata }).usage_metadata;
    if (promptTokens == null && um) {
      promptTokens = um.input_tokens;
      completionTokens = um.output_tokens;
      totalTokens = um.total_tokens;
      cacheReadTokens = um.input_token_details?.cache_read ?? 0;
      cacheWriteTokens = um.input_token_details?.cache_creation ?? 0;
    }
    void recordLlmCall({
      unitId: args.unitId,
      traceId: args.traceId,
      provider: args.provider ?? 'openai',
      model: args.modelName,
      endpoint: 'chat.completions',
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      latencyMs,
      status: 'success',
      requestBody: {
        model: args.modelName,
        toolNames: args.tools?.map((t) => t.name) ?? [],
        messages: args.messages.map((m) => ({
          role: m.getType(),
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      },
      responseBody: rawResponse,
    });

    return response;
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const msg = err instanceof Error ? err.message : String(err);
    void recordLlmCall({
      unitId: args.unitId,
      traceId: args.traceId,
      provider: args.provider ?? 'openai',
      model: args.modelName,
      endpoint: 'chat.completions',
      latencyMs,
      status: 'error',
      errorMessage: msg,
      requestBody: {
        model: args.modelName,
        toolNames: args.tools?.map((t) => t.name) ?? [],
      },
    });
    throw err;
  }
}

export type { ChatOpenAI };
