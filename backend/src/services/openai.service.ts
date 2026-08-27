import { ChatOpenAI, type ChatOpenAICallOptions } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { Prisma } from '@prisma/client';
import type { Unit } from '@prisma/client';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { prisma } from '../lib/prisma.js';
import { registrarGasto } from '../agent/teto-conversa.js';
import { mascararPiiProfundo } from '../lib/pii.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { opsAlert, ehErroDeSaldo } from '../lib/ops-alert.js';

interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-2024-11-20': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30 },
  'gpt-4': { inputPer1M: 30, outputPer1M: 60 },
  'gpt-5-mini': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'gpt-5': { inputPer1M: 5, outputPer1M: 15 },
  'o1-mini': { inputPer1M: 3, outputPer1M: 12 },
  'o1': { inputPer1M: 15, outputPer1M: 60 },
  'claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25 },
  'claude-sonnet-5': { inputPer1M: 2, outputPer1M: 10 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5 },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 },
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },
};

const CACHE_MULTIPLIERS: Record<string, { read: number; write: number }> = {
  anthropic: { read: 0.1, write: 2 },
  openai: { read: 0.5, write: 0 },
  google: { read: 0.25, write: 0 },
};

export function providerOfModel(model: string): 'anthropic' | 'openai' | 'google' {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'google';
  return 'openai';
}

export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  const mult = CACHE_MULTIPLIERS[providerOfModel(model)];
  const uncached = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const inputCost =
    (uncached / 1_000_000) * price.inputPer1M +
    (cacheReadTokens / 1_000_000) * price.inputPer1M * mult.read +
    (cacheWriteTokens / 1_000_000) * price.inputPer1M * mult.write;
  const outputCost = (completionTokens / 1_000_000) * price.outputPer1M;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

export function resolveOpenAIApiKey(unit: Pick<Unit, 'openaiApiKey'> | null): string {
  return unit?.openaiApiKey || env.OPENAI_API_KEY;
}

export interface ChatOpenAIOverrides {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 15000;

/**
 * Teto de espera do cliente HTTP, para TODO provedor. O grafo já tem o seu
 * (withTimeout), mas aquele corta só a espera de quem chamou: a requisição segue
 * viva, ocupando conexão e podendo ser cobrada mesmo depois de a resposta não
 * servir mais para ninguém. Um pouco maior que o do OpenAI porque Anthropic e
 * Google costumam demorar mais com prompt grande.
 */
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 30000;
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
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
  });
}

export type ChatModel =
  | ChatOpenAI<ChatOpenAICallOptions>
  | ChatAnthropic
  | ChatGoogleGenerativeAI;

const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high']);

export function resolveAnthropicEffort(v: string | null | undefined): 'low' | 'medium' | 'high' | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return ANTHROPIC_EFFORTS.has(s) ? (s as 'low' | 'medium' | 'high') : null;
}

export function createChatModel(
  unit: Unit | null,
  overrides: ChatOpenAIOverrides = {},
): ChatModel {
  if (unit?.llmProvider === 'anthropic' && unit.anthropicApiKey) {
    const effort = resolveAnthropicEffort(unit.anthropicEffort);
    return new ChatAnthropic({
      apiKey: unit.anthropicApiKey,
      model: overrides.model ?? unit.anthropicModel ?? 'claude-opus-4-8',
      maxTokens: overrides.maxTokens ?? unit.openaiMaxTokens ?? 1024,
      maxRetries: OPENAI_MAX_RETRIES,
      // Sem timeout aqui, o withTimeout do grafo corta a ESPERA mas a requisição
      // HTTP continua viva em segundo plano, segurando conexão e podendo cobrar.
      clientOptions: { timeout: LLM_TIMEOUT_MS },
      thinking: { type: 'disabled' },
      ...(effort ? { outputConfig: { effort } } : {}),
    });
  }
  if (unit?.llmProvider === 'google' && unit.googleApiKey) {
    return new ChatGoogleGenerativeAI({
      apiKey: unit.googleApiKey,
      model: overrides.model ?? unit.googleModel ?? 'gemini-2.5-flash',
      temperature: overrides.temperature ?? unit.openaiTemperature ?? 0,
      maxOutputTokens: overrides.maxTokens ?? unit.openaiMaxTokens ?? 1024,
      maxRetries: OPENAI_MAX_RETRIES,
      // O cliente do Google não aceita timeout no construtor — aqui a proteção
      // fica só com o withTimeout do grafo. Está registrado na tela Saúde da IA
      // pra ninguém achar que está coberto.
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    });
  }
  return createChatOpenAI(unit, overrides);
}

export interface RecordLlmCallParams {
  unitId: string | null;
  traceId: string | null;
  provider?: string;
  model: string;
  endpoint?: 'chat.completions' | 'assistants';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
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
    logger.error({ err }, 'falha ao gravar LlmCall');
  }
}

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
  provider?: string;
  tools?: Pick<StructuredToolInterface, 'name'>[];
  /**
   * Identificador da CONVERSA (não da execução). Serve pro teto de gasto, que
   * precisa somar o que uma conversa inteira custou — o traceId muda a cada
   * mensagem e não serviria.
   */
  conversaId?: string | null;
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

    const stopReason = (response as { additional_kwargs?: { stop_reason?: string } })
      .additional_kwargs?.stop_reason;
    if (stopReason === 'max_tokens') {
      logger.warn(
        { unitId: args.unitId, model: args.modelName, traceId: args.traceId },
        'resposta truncada por max_tokens — aumentar openaiMaxTokens da unidade',
      );
    }

    const finalUsage: TokenUsage = usage ?? {};
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
    if (args.conversaId) {
      registrarGasto(
        args.conversaId,
        calculateCost(
          args.modelName,
          promptTokens ?? 0,
          completionTokens ?? 0,
          cacheReadTokens,
          cacheWriteTokens,
        ),
      );
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
      // A conversa fica guardada porque é o que permite investigar depois — mas
      // mascarada: telefone, CPF, CNPJ e e-mail saem, a queixa e o nome ficam.
      // Sem a queixa o registro não serve pra nada; com o telefone, vira base de
      // dado pessoal que ninguém pediu pra existir.
      requestBody: mascararPiiProfundo({
        model: args.modelName,
        toolNames: args.tools?.map((t) => t.name) ?? [],
        messages: args.messages.map((m) => ({
          role: m.getType(),
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      }),
      responseBody: mascararPiiProfundo(rawResponse),
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
    if (ehErroDeSaldo(msg)) {
      opsAlert({
        chave: `saldo:${args.provider ?? 'openai'}`,
        title: `IA sem saldo (${args.provider ?? 'openai'}) — atendimento parado`,
        message:
          `As chamadas à IA estão falhando por saldo/cota esgotada no provedor ` +
          `"${args.provider ?? 'openai'}" (modelo ${args.modelName}). Enquanto não ` +
          `recarregar, NENHUMA conversa é respondida. Erro do provedor: ${msg.slice(0, 300)}`,
      });
    }
    throw err;
  }
}

export type { ChatOpenAI };
