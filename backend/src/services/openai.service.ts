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
  /** Leitura de cache como fração do preço de entrada. Sem isto vale a do provedor (Anthropic 0,1×). */
  cacheReadMult?: number;
  /** Faixa de contexto longo: prompt acima do limite é cobrado inteiro neste preço (Haiku 5.5). */
  contextoLongo?: { acimaDeTokens: number; inputPer1M: number; outputPer1M: number };
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
  // Família 5.5. Opus 5.5: leitura de cache a US$ 0,20/MTok = 0,05× a entrada (nos outros é 0,1×).
  // Haiku 5.5: acima de 100 mil tokens de prompt a chamada inteira passa a US$ 0,50/2,50.
  'claude-sonnet-5-5': { inputPer1M: 2, outputPer1M: 10 },
  'claude-opus-5-5': { inputPer1M: 4, outputPer1M: 20, cacheReadMult: 0.05 },
  'claude-haiku-5-5': {
    inputPer1M: 0.1,
    outputPer1M: 0.5,
    contextoLongo: { acimaDeTokens: 100_000, inputPer1M: 0.5, outputPer1M: 2.5 },
  },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 },
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },
};

// A Anthropic cobra a gravação de cache por TTL: 5 min a 1,25× e 1 h a 2× o preço de entrada. Até
// 21/09/2026 tudo era cobrado a 2× — e o cache da conversa (5 min) é quase toda a gravação de uma
// chamada normal, então o custo medido saía ~10 % acima do real.
const CACHE_MULTIPLIERS: Record<string, { read: number; write5m: number; write1h: number }> = {
  anthropic: { read: 0.1, write5m: 1.25, write1h: 2 },
  openai: { read: 0.5, write5m: 0, write1h: 0 },
  google: { read: 0.25, write5m: 0, write1h: 0 },
};

export function providerOfModel(model: string): 'anthropic' | 'openai' | 'google' {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'google';
  return 'openai';
}

/**
 * Preço de um modelo `claude-*` fora da tabela: o MAIOR preço de entrada e o MAIOR de saída entre os modelos Anthropic
 * da tabela (só os `claude-*`: um modelo de outro provedor mais caro não entra). O teto de gasto (por conversa e o
 * mensal da clínica) soma isto — devolver 0 o desligaria em silêncio; superestimar só o faz cortar um pouco antes.
 * Leitura de cache no padrão Anthropic (0,1×, o maior entre os conhecidos); sem faixa de contexto longo.
 */
const PRECO_ANTHROPIC_MAIS_CARO: ModelPrice = Object.entries(MODEL_PRICES)
  .filter(([nome]) => nome.startsWith('claude'))
  .map(([, p]) => p)
  .reduce<ModelPrice>(
    (a, b) => ({
      inputPer1M: Math.max(a.inputPer1M, b.inputPer1M),
      outputPer1M: Math.max(a.outputPer1M, b.outputPer1M),
    }),
    { inputPer1M: 0, outputPer1M: 0 },
  );

const modelosSemPrecoAvisados = new Set<string>();

function precoDoModelo(model: string): ModelPrice | null {
  const price = MODEL_PRICES[model];
  if (price) return price;
  if (!model.startsWith('claude')) return null;
  // Só sufixo de data (`-AAAAMMDD`) ou `-latest` é o MESMO modelo com outro apelido. Outro número de versão
  // (`claude-sonnet-5-6`, `claude-opus-5-6`) é modelo novo, com preço próprio: não herda o do `-5` — cai no aviso.
  const base = /^(claude-.+?)-(?:\d{8}|latest)$/.exec(model)?.[1];
  if (base && MODEL_PRICES[base]) return MODEL_PRICES[base]!;
  if (!modelosSemPrecoAvisados.has(model)) {
    modelosSemPrecoAvisados.add(model);
    logger.warn(
      { model },
      'modelo Anthropic fora da tabela de preços (MODEL_PRICES) — custo estimado pelo modelo mais caro; incluir o preço',
    );
  }
  return PRECO_ANTHROPIC_MAIS_CARO;
}

export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheWrite5mTokens = 0,
  cacheWrite1hTokens = 0,
): number {
  const tabela = precoDoModelo(model);
  if (!tabela) return 0;
  const longo = tabela.contextoLongo && promptTokens > tabela.contextoLongo.acimaDeTokens ? tabela.contextoLongo : null;
  const price = longo ?? tabela;
  const mult = CACHE_MULTIPLIERS[providerOfModel(model)];
  const multLeitura = tabela.cacheReadMult ?? mult.read;
  const uncached = Math.max(0, promptTokens - cacheReadTokens - cacheWrite5mTokens - cacheWrite1hTokens);
  const inputCost =
    (uncached / 1_000_000) * price.inputPer1M +
    (cacheReadTokens / 1_000_000) * price.inputPer1M * multLeitura +
    (cacheWrite5mTokens / 1_000_000) * price.inputPer1M * mult.write5m +
    (cacheWrite1hTokens / 1_000_000) * price.inputPer1M * mult.write1h;
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

type EffortAnthropic = 'low' | 'medium' | 'high';

/** O que o ChatAnthropic recebe para controlar o raciocínio do modelo. */
export interface RaciocinioAnthropic {
  thinking: { type: 'disabled' } | { type: 'adaptive' };
  /** Sobrescreve o `thinking` no payload (o LangChain espalha `invocationKwargs` depois dele). */
  invocationKwargs?: Record<string, unknown>;
  outputConfig?: { effort: EffortAnthropic };
}

/**
 * Como pedir "sem pensar" a cada família da Anthropic. Mandar `thinking: disabled` a qualquer modelo dá 400
 * na 5.5. Os modelos de hoje (opus-4-8, sonnet-5, sonnet-4-6, haiku-4-5) seguem EXATAMENTE como estavam: `disabled`.
 *
 * - Sonnet 5.5: `disabled` não existe; o equivalente é `{type:'between_tools'}` (só com effort ≤ high, e sem outro
 *   campo). O tipo do LangChain não o declara — vai por `invocationKwargs`, que sobrescreve o `thinking` do payload.
 *   O `adaptive` do construtor só satisfaz o tipo e é descartado.
 * - Opus 5.5: pensa sempre; `thinking` não pode ser `disabled` nem ter budget. `adaptive` equivale a omitir (o LangChain
 *   não deixa omitir: o padrão dele é `disabled`). O controle é o effort, e o padrão da API (medium) é mais caro que
 *   o "sem pensar" de hoje — sem effort na unidade mandamos `low` para manter o custo.
 * - Haiku 5.5: `disabled` vale com effort ≤ high (os que a unidade pode ter) — mantém o comportamento atual.
 */
export function configurarRaciocinioAnthropic(modelo: string, effort: EffortAnthropic | null): RaciocinioAnthropic {
  const familia = /^claude-(sonnet|opus|haiku)-5-5(?![0-9])/.exec(modelo)?.[1];
  const outputConfig = (e: EffortAnthropic | null) => (e ? { outputConfig: { effort: e } } : {});
  if (familia === 'sonnet') {
    return { thinking: { type: 'adaptive' }, invocationKwargs: { thinking: { type: 'between_tools' } }, ...outputConfig(effort) };
  }
  if (familia === 'opus') {
    return { thinking: { type: 'adaptive' }, ...outputConfig(effort ?? 'low') };
  }
  return { thinking: { type: 'disabled' }, ...outputConfig(effort) };
}

/**
 * Opus 5.5 pensa sempre e o raciocínio conta DENTRO de `max_tokens`. Os limites de hoje (1024 do atendimento, 600
 * da memória, 400 da reescrita, 300 do follow-up, 1 do keepalive) foram dimensionados para modelo sem pensar:
 * com eles a resposta voltaria cortada ou sem texto. Piso só para a Opus 5.5 — os outros modelos seguem com o
 * valor pedido, byte a byte. O keepalive (1 token, só para manter o cache quente) também sobe: o piso é por modelo,
 * não por chamada, e a documentação não garante que `max_tokens: 1` seja aceito com raciocínio sempre ligado.
 */
export const PISO_MAX_TOKENS_OPUS_5_5 = 4096;

export function maxTokensComFolga(modelo: string, maxTokens: number): number {
  return /^claude-opus-5-5(?![0-9])/.test(modelo) ? Math.max(maxTokens, PISO_MAX_TOKENS_OPUS_5_5) : maxTokens;
}

export function resolveModelName(unit: Unit | null, override?: string | null): string {
  if (override) return override;
  if (unit?.llmProvider === 'anthropic' && unit.anthropicApiKey) {
    return unit.anthropicModel ?? 'claude-opus-4-8';
  }
  if (unit?.llmProvider === 'google' && unit.googleApiKey) {
    return unit.googleModel ?? 'gemini-2.5-flash';
  }
  return unit?.openaiModel ?? env.OPENAI_MODEL;
}

export function createChatModel(
  unit: Unit | null,
  overrides: ChatOpenAIOverrides = {},
): ChatModel {
  if (unit?.llmProvider === 'anthropic' && unit.anthropicApiKey) {
    const effort = resolveAnthropicEffort(unit.anthropicEffort);
    const modelo = overrides.model ?? unit.anthropicModel ?? 'claude-opus-4-8';
    return new ChatAnthropic({
      apiKey: unit.anthropicApiKey,
      model: modelo,
      maxTokens: maxTokensComFolga(modelo, overrides.maxTokens ?? unit.openaiMaxTokens ?? 1024),
      maxRetries: OPENAI_MAX_RETRIES,
      // Sem timeout aqui, o withTimeout do grafo corta a ESPERA mas a requisição
      // HTTP continua viva em segundo plano, segurando conexão e podendo cobrar.
      clientOptions: { timeout: LLM_TIMEOUT_MS },
      ...configurarRaciocinioAnthropic(modelo, effort),
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
  /** Gravação de cache de 5 min (a conversa). */
  cacheWrite5mTokens?: number;
  /** Gravação de cache de 1 h (o prefixo: ferramentas + prompt fixo). */
  cacheWrite1hTokens?: number;
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
    p.cacheWrite5mTokens ?? 0,
    p.cacheWrite1hTokens ?? 0,
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

/** Detalhe bruto da Anthropic (`usage.cache_creation`): quanto foi cache de 5 min e quanto de 1 h. */
interface CacheCreationAnthropic {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
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
  /**
   * A chamada para no teto de propósito (o cache-keepalive pede 1 token só para manter o prefixo quente).
   * Sem isto ela disparava o canário de truncamento ~240×/dia e afogava os cortes de verdade (medido em 19/10/2026).
   */
  corteEsperado?: boolean;
}

/**
 * O modelo se recusou a responder (`stop_reason: "refusal"`). Não é queda de infraestrutura: o provedor está de pé e
 * respondeu. O texto vem vazio ou cortado — NUNCA pode ir ao paciente —, então o grafo trata como falha do principal
 * (plano B; sem plano B, o fallback de indisponível), mas sem contar para o circuito de "provedor fora".
 * A mensagem evita de propósito as palavras que o `ehFalhaDeInfra` reconhece.
 */
export class LlmRecusaError extends Error {
  readonly categoria: string | null;
  constructor(categoria: string | null = null) {
    super(`o modelo recusou responder (stop_reason=refusal${categoria ? `, categoria=${categoria}` : ''})`);
    this.name = 'LlmRecusaError';
    this.categoria = categoria;
  }
}

/**
 * Lê a recusa na resposta do LangChain. O `stop_reason` vem em `additional_kwargs` (e, conforme a versão, em
 * `response_metadata`); a categoria (`cyber`/`bio`/null), em `stop_details.category` no mesmo lugar.
 * Devolve null quando não houve recusa.
 */
export function detectarRecusa(response: unknown): { categoria: string | null } | null {
  const r = response as {
    additional_kwargs?: { stop_reason?: string; stop_details?: { category?: string | null } | null };
    response_metadata?: { stop_reason?: string; stop_details?: { category?: string | null } | null };
  } | null;
  const fontes = [r?.additional_kwargs, r?.response_metadata];
  if (!fontes.some((f) => f?.stop_reason === 'refusal')) return null;
  const categoria = fontes.map((f) => f?.stop_details?.category).find((c) => typeof c === 'string') ?? null;
  return { categoria };
}

/** O canário de truncamento: só avisa quando o corte não foi pedido. */
export function avisarCorte(stopReason: string | undefined, corteEsperado = false): boolean {
  return stopReason === 'max_tokens' && !corteEsperado;
}

export async function invokeChatModel(args: InvokeChatModelArgs): Promise<unknown> {
  const t0 = performance.now();
  let usage: TokenUsage | null = null;
  let rawResponse: unknown = null;
  // Num objeto, não num `let`: o TS estreita `let x = null` pra `null` e não vê a atribuição no callback.
  const captura: { cacheCreation: CacheCreationAnthropic | null } = { cacheCreation: null };

  try {
    const response = await args.model.invoke(args.messages, {
      callbacks: [
        {
          handleLLMEnd: (output: {
            llmOutput?: { tokenUsage?: TokenUsage; usage?: { cache_creation?: CacheCreationAnthropic } };
          }) => {
            usage = output.llmOutput?.tokenUsage ?? null;
            captura.cacheCreation = output.llmOutput?.usage?.cache_creation ?? null;
            rawResponse = output;
          },
        },
      ],
    });
    const latencyMs = Math.round(performance.now() - t0);

    const stopReason = (response as { additional_kwargs?: { stop_reason?: string } })
      .additional_kwargs?.stop_reason;
    if (avisarCorte(stopReason, args.corteEsperado)) {
      logger.warn(
        { unitId: args.unitId, model: args.modelName, traceId: args.traceId },
        'resposta truncada por max_tokens — aumentar openaiMaxTokens da unidade',
      );
    }

    const recusa = detectarRecusa(response);
    const erroRecusa = recusa ? new LlmRecusaError(recusa.categoria) : null;

    const finalUsage: TokenUsage = usage ?? {};
    let { promptTokens, completionTokens, totalTokens } = finalUsage;
    let cacheReadTokens = 0;
    let cacheWrite5mTokens = 0;
    let cacheWrite1hTokens = 0;
    const um = (response as { usage_metadata?: AnthropicUsageMetadata }).usage_metadata;
    if (promptTokens == null && um) {
      promptTokens = um.input_tokens;
      completionTokens = um.output_tokens;
      totalTokens = um.total_tokens;
      cacheReadTokens = um.input_token_details?.cache_read ?? 0;
      const gravado = um.input_token_details?.cache_creation ?? 0;
      // A Anthropic separa quanto foi cache de 5 min e quanto de 1 h — e cobra diferente (1,25× vs 2×).
      // Sem o detalhe, tudo vai como 1 h: erra pra cima, nunca pra baixo.
      const bruto = captura.cacheCreation;
      if (bruto && (bruto.ephemeral_5m_input_tokens != null || bruto.ephemeral_1h_input_tokens != null)) {
        cacheWrite5mTokens = bruto.ephemeral_5m_input_tokens ?? 0;
        cacheWrite1hTokens = bruto.ephemeral_1h_input_tokens ?? 0;
      } else {
        cacheWrite1hTokens = gravado;
      }
    }
    if (args.conversaId) {
      registrarGasto(
        args.conversaId,
        calculateCost(
          args.modelName,
          promptTokens ?? 0,
          completionTokens ?? 0,
          cacheReadTokens,
          cacheWrite5mTokens,
          cacheWrite1hTokens,
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
      cacheWrite5mTokens,
      cacheWrite1hTokens,
      latencyMs,
      // Recusa gasta token (o custo fica gravado) mas conta como erro: aparece no painel e no alarme de taxa de erro.
      status: erroRecusa ? 'error' : 'success',
      errorMessage: erroRecusa?.message,
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

    // Depois de gravar o gasto (a recusa também consome token): resposta recusada não segue para o paciente.
    if (recusa && erroRecusa) {
      logger.warn(
        { unitId: args.unitId, model: args.modelName, traceId: args.traceId, categoria: recusa.categoria },
        'modelo recusou responder (stop_reason=refusal) — tratando como falha do principal',
      );
      throw erroRecusa;
    }

    return response;
  } catch (err) {
    // Já gravada acima (com o gasto) — não regrava nem dispara o alerta de saldo.
    if (err instanceof LlmRecusaError) throw err;
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
