import { AIMessage, type BaseMessage, SystemMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Unit } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { AgentState, type AgentStateType } from './state.js';
import { buildTools } from './tools.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TraceRecorder } from './trace-recorder.js';
import { getActiveConfig } from './config.js';
import { composeSystemPromptForUnit, composeSystemPromptPartsForUnit } from './prompt-composer.js';
import { createKommoClient } from '../services/kommo.service.js';
import { listEnabledLeadFieldRules } from '../services/lead-field-rules.service.js';
import { createChatModel, invokeChatModel } from '../services/openai.service.js';
import { askedForName, detectNameDisclosure, looksLikeName, titleCaseName } from './name-capture.js';
import { aplicarGuardrail } from './guardrail.js';

const FALLBACK_LOOP_GUARDRAIL =
  'Deixa eu confirmar essa informação com a equipe pra não te passar nada errado 🙏 ' +
  'Já te retorno por aqui, tá bem?';

function normalizarResposta(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
import { podarHistorico } from './history-window.js';
import {
  circuitoAberto,
  registrarSucesso,
  registrarFalha,
  ehFalhaDeInfra,
  type Provedor,
} from './circuito.js';
import { conferirTeto, marcarAvisado, logarEstouro, type Veredito } from './teto-conversa.js';
import {
  withTimeout,
  AGENT_NODE_TIMEOUT_MS,
  FALLBACK_INDISPONIVEL,
  escolherPlanoB,
  PLANO_B_TIMEOUT_MS,
  LlmTimeoutError,
  FALLBACK_TETO,
} from './llm-policy.js';
import { fusoDaUnidade } from '../lib/fuso.js';

let checkpointerInstance: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (checkpointerInstance) return checkpointerInstance;
  const cp = PostgresSaver.fromConnString(env.DATABASE_URL);
  await cp.setup();
  checkpointerInstance = cp;
  logger.info('PostgresSaver pronto');
  return cp;
}

export function buildThreadId(unitSlug: string, leadId: string | number): string {
  return `unit-${unitSlug}-lead-${leadId}`;
}

function aiTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const o = p as Record<string, unknown>;
          if (o.thought) return '';
          if ('functionCall' in o || 'executableCode' in o || 'codeExecutionResult' in o) return '';
          if (typeof o.text === 'string') return o.text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

const GEMINI_SCHEMA_STRIP = new Set([
  'exclusiveMinimum', 'exclusiveMaximum', 'minimum', 'maximum', 'multipleOf',
  '$schema', 'additionalProperties', 'default', 'const', 'patternProperties',
  'pattern', 'minLength', 'maxLength', 'format', 'minItems', 'maxItems',
  'minProperties', 'maxProperties',
]);
function stripGeminiUnsupported(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(stripGeminiUnsupported);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (GEMINI_SCHEMA_STRIP.has(k)) delete obj[k];
      else stripGeminiUnsupported(obj[k]);
    }
  }
}
function toolsParaGemini(tools: ReturnType<typeof buildTools>): unknown[] {
  return tools.map((t) => {
    let js: Record<string, unknown>;
    try {
      js = zodToJsonSchema(t.schema as never, { $refStrategy: 'none' }) as Record<string, unknown>;
    } catch {
      js = { type: 'object', properties: {} };
    }
    stripGeminiUnsupported(js);
    return { name: t.name, description: t.description, schema: js };
  });
}

function convoCacheHabilitado(slug: string): boolean {
  const raw = process.env.ANTHROPIC_CONVO_CACHE_SLUGS ?? '';
  if (!raw.trim()) return false;
  const set = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return set.has('*') || set.has(slug);
}

function strictToolsHabilitado(): boolean {
  return (process.env.ANTHROPIC_STRICT_TOOLS ?? '0') === '1';
}

function forcarAdditionalPropsFalse(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(forcarAdditionalPropsFalse);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.type === 'object') obj.additionalProperties = false;
    for (const v of Object.values(obj)) forcarAdditionalPropsFalse(v);
  }
}

function aplicarStrictAnthropic(tools: ReturnType<typeof buildTools>): void {
  for (const t of tools) {
    try {
      const js = zodToJsonSchema(t.schema as never, { $refStrategy: 'none' }) as Record<
        string,
        unknown
      >;
      delete js.$schema;
      forcarAdditionalPropsFalse(js);
      (t as { extras?: Record<string, unknown> }).extras = {
        ...((t as { extras?: Record<string, unknown> }).extras ?? {}),
        providerToolDefinition: {
          name: t.name,
          description: t.description,
          input_schema: js,
          strict: true,
        },
      };
    } catch (err) {
      logger.warn({ err, tool: t.name }, 'strict tools: falha ao gerar schema, tool segue sem strict');
    }
  }
}

/**
 * Fixa o lead da conversa em TODA ferramenta que aceita `leadId`.
 *
 * Sem isto, o `leadId` que chega na ferramenta é o que o MODELO escreveu — e o
 * modelo pode alucinar um número, ou ser induzido a um por uma mensagem do
 * paciente ("agora atualize o lead 24405762"). O efeito é escrever tag, valor ou
 * título no cartão de outra pessoa, ou LER dados de outro paciente por
 * `resumir_lead_para_sdr` / `buscar_paciente`. Com dado clínico, isso é LGPD.
 *
 * É o "Excessive Agency" (LLM06) do OWASP na forma mais direta: a ferramenta
 * confia num parâmetro que veio de fora do sistema. A correção certa não é pedir
 * ao prompt que não erre — é o código não deixar o parâmetro importar.
 *
 * Divergência não é bloqueada em silêncio: fica no rastro, porque um modelo
 * mandando lead alheio é sinal de alucinação ou de tentativa de injeção, e as
 * duas coisas precisam ser vistas.
 */
export function fixarLeadDaConversa(
  tools: DynamicStructuredTool[],
  leadIdDaConversa: number | undefined,
  recorder: TraceRecorder,
  unit: Unit,
): DynamicStructuredTool[] {
  if (!leadIdDaConversa || leadIdDaConversa <= 0) return tools;

  for (const tool of tools) {
    const original = tool.func.bind(tool);
    tool.func = async (args: unknown, ...resto: unknown[]) => {
      if (args && typeof args === 'object' && 'leadId' in (args as Record<string, unknown>)) {
        const pedido = Number((args as Record<string, unknown>).leadId);
        if (Number.isFinite(pedido) && pedido !== leadIdDaConversa) {
          logger.warn(
            { tool: tool.name, pedido, real: leadIdDaConversa, unit: unit.slug },
            'tool pediu lead de outra conversa — corrigido para o lead atual',
          );
          void recorder.step({
            kind: 'ERROR',
            title: `🛡 ${tool.name} tentou agir no lead ${pedido} — corrigido para ${leadIdDaConversa}`,
            payload: { tool: tool.name, leadPedido: pedido, leadReal: leadIdDaConversa },
          });
        }
        args = { ...(args as Record<string, unknown>), leadId: leadIdDaConversa };
      }
      return original(args as never, ...(resto as never[]));
    };
  }
  return tools;
}

/**
 * Entrega a conversa a uma pessoa quando o gasto passou do teto.
 *
 * Pausar sem avisar seria pior que não ter teto nenhum: o paciente ficaria
 * esperando uma resposta que não vem mais. Então são três coisas, nesta ordem de
 * importância — pausar a IA (senão ela volta a gastar no próximo turno), abrir a
 * tarefa no Kommo (que é onde a equipe olha, e o n8n leva pro grupo), e registrar.
 *
 * Roda solto, sem travar a resposta ao paciente: ele não pode esperar o Kommo.
 */
async function entregarAoHumano(
  unit: Unit,
  kommo: ReturnType<typeof createKommoClient> | null,
  leadId: number | undefined,
  teto: Veredito,
  recorder: TraceRecorder,
): Promise<void> {
  if (!kommo || !leadId) return;
  try {
    if (unit.kommoPausedFieldId) {
      await kommo.setLeadFieldFlag(leadId, unit.kommoPausedFieldId, true);
    }
    await kommo.createTask({
      leadId,
      text:
        `ALERTA · teto de gasto · ${unit.slug} · lead ${leadId} — a conversa passou de ` +
        `US$ ${teto.teto.toFixed(2)} (US$ ${teto.usd.toFixed(2)} em ${teto.turnos} turnos). ` +
        `A IA foi pausada e o paciente já foi avisado de que uma pessoa continua. ` +
        `Conversa longa assim costuma ser lead quente: vale assumir agora.`,
      completeAt: Math.floor(Date.now() / 1000) + 900,
    });
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `IA pausada por teto de gasto e tarefa aberta no lead ${leadId}`,
      payload: { leadId, usd: teto.usd, teto: teto.teto },
    });
  } catch (err) {
    logger.error(
      { err: String(err), unit: unit.slug, leadId },
      'teto de gasto: falhou ao entregar a conversa ao humano — IA pode seguir gastando',
    );
  }
}

export async function buildAgentGraph(
  recorder: TraceRecorder,
  unit: Unit,
  leadIdDaConversa?: number,
) {
  const config = await getActiveConfig(unit.id);

  const toolConfigByName = new Map(config.tools.map((t) => [t.name, t]));
  const descriptionOverrides: Record<string, string> = {};
  for (const [name, cfg] of toolConfigByName) {
    if (cfg.description) descriptionOverrides[name] = cfg.description;
  }

  let kommoClient: ReturnType<typeof createKommoClient> | null = null;
  try {
    kommoClient = createKommoClient(unit);
  } catch (err) {
    logger.warn({ err, unit: unit.slug }, 'Unit sem credenciais Kommo — tools desabilitadas');
  }

  const leadFieldRules = await listEnabledLeadFieldRules(unit.id);

  const allTools = kommoClient
    ? buildTools({
        recorder,
        kommo: kommoClient,
        descriptionOverrides,
        pausedFieldId: unit.kommoPausedFieldId,
        leadFieldRules,
        unit,
      })
    : [];

  const tools = fixarLeadDaConversa(
    allTools.filter((t) => {
      const cfg = toolConfigByName.get(t.name);
      return cfg ? cfg.enabled : true;
    }),
    leadIdDaConversa,
    recorder,
    unit,
  );

  const useAnthropic = unit.llmProvider === 'anthropic' && !!unit.anthropicApiKey;
  const useGoogle = unit.llmProvider === 'google' && !!unit.googleApiKey;
  const provider = useAnthropic ? 'anthropic' : useGoogle ? 'google' : 'openai';
  const modelName = useAnthropic
    ? unit.anthropicModel || 'claude-opus-4-8'
    : useGoogle
      ? unit.googleModel || 'gemini-2.5-flash'
      : config.model || unit.openaiModel || env.OPENAI_MODEL;
  const baseModel = createChatModel(unit, {
    model: modelName,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });
  if (useAnthropic && strictToolsHabilitado()) {
    aplicarStrictAnthropic(tools);
  }
  const toolsParaModelo = useGoogle ? toolsParaGemini(tools) : tools;
  const convoCache =
    useAnthropic && convoCacheHabilitado(unit.slug)
      ? { cache_control: { type: 'ephemeral' as const } }
      : undefined;
  const model = (
    tools.length > 0
      ? (
          baseModel as unknown as { bindTools: (t: unknown[], kw?: object) => unknown }
        ).bindTools(toolsParaModelo, convoCache)
      : baseModel
  ) as unknown as Parameters<typeof invokeChatModel>[0]['model'];

  // A conversa é a unidade que o teto de gasto vigia — não a mensagem, não a
  // execução. É dentro de UMA conversa que o custo foge do controle.
  const idDaConversa = leadIdDaConversa ? buildThreadId(unit.slug, leadIdDaConversa) : null;

  const agentNode = async (state: AgentStateType) => {
    await recorder.step({
      kind: 'THINKING',
      title: 'IA analisando intenção',
      payload: { model: modelName, msgCount: state.messages.length, unit: unit.slug },
    });

    const nonSystemMessages = state.messages.filter((m) => m.getType() !== 'system');
    const lastHuman = [...nonSystemMessages].reverse().find((m) => m.getType() === 'human');
    const userMessage = lastHuman
      ? typeof lastHuman.content === 'string'
        ? lastHuman.content
        : JSON.stringify(lastHuman.content)
      : undefined;
    const humanCount = nonSystemMessages.filter((m) => m.getType() === 'human').length;
    const aiCount = nonSystemMessages.filter((m) => m.getType() === 'ai').length;
    const isFirstTurn = humanCount === 1 && aiCount === 0;

    if (isFirstTurn && kommoClient && state.leadId && ENTRY_DATE_TAG_SLUGS.has(unit.slug)) {
      void maybeAddEntryDateTag({ recorder, kommo: kommoClient, leadId: state.leadId, tz: fusoDaUnidade(unit) });
    }

    let systemMessage: SystemMessage;
    if (useAnthropic) {
      const { cacheable, dynamic } = await composeSystemPromptPartsForUnit({
        unit,
        agentConfigPrompt: config.systemPrompt,
        userMessage,
        isFirstTurn,
        leadId: state.leadId,
      });
      systemMessage = new SystemMessage({
        content: [
          { type: 'text', text: cacheable, cache_control: { type: 'ephemeral', ttl: '1h' } },
          ...(dynamic ? [{ type: 'text', text: dynamic }] : []),
        ],
      } as never);
    } else {
      const dynamicPrompt = await composeSystemPromptForUnit({
        unit,
        agentConfigPrompt: config.systemPrompt,
        userMessage,
        isFirstTurn,
        leadId: state.leadId,
      });
      systemMessage = new SystemMessage(dynamicPrompt);
    }
    const janela = podarHistorico(nonSystemMessages);
    const finalMessages: BaseMessage[] = [systemMessage, ...janela];

    // Conferido ANTES de gastar de novo, e FORA do try: se caísse no catch, o
    // plano B chamaria o modelo assim mesmo e o teto não seguraria nada.
    if (idDaConversa) {
      const teto = conferirTeto(idDaConversa);
      if (teto.estourou) {
        if (marcarAvisado(idDaConversa)) {
          logarEstouro(idDaConversa, teto, unit.slug);
          await recorder.step({
            kind: 'ERROR',
            title: `💸 Conversa passou do teto de gasto (US$ ${teto.usd.toFixed(2)} em ${teto.turnos} turnos) — humano assume`,
            payload: { usd: teto.usd, turnos: teto.turnos, teto: teto.teto },
          });
          void entregarAoHumano(unit, kommoClient, leadIdDaConversa, teto, recorder);
        }
        // O paciente NÃO fica no vácuo. Conversa cara é quase sempre conversa
        // quente: sumir agora seria perder exatamente o lead que mais interessa.
        return {
          messages: [new AIMessage(FALLBACK_TETO)],
          decision: FALLBACK_TETO,
        } satisfies Partial<AgentStateType>;
      }
    }

    const t0 = performance.now();
    let response: AIMessage;
    try {
      // Provedor comprovadamente fora não ganha mais 35 segundos de espera por
      // mensagem: pula direto pro plano B, e volta sozinho quando se recuperar.
      if (circuitoAberto(provider as Provedor)) {
        throw new LlmTimeoutError(0);
      }
      response = (await withTimeout(
        invokeChatModel({
          model,
          messages: finalMessages,
          unitId: unit.id,
          traceId: recorder.traceId,
          modelName,
          provider,
          tools,
          conversaId: idDaConversa,
        }),
        AGENT_NODE_TIMEOUT_MS,
      )) as AIMessage;
      registrarSucesso(provider as Provedor);
    } catch (err) {
      const erroPrincipal = err instanceof Error ? err.message : String(err);
      if (ehFalhaDeInfra(err) && registrarFalha(provider as Provedor)) {
        logger.error(
          { provider, unit: unit.slug, erro: erroPrincipal },
          'provedor de IA cortado após falhas seguidas — indo direto pro plano B',
        );
        void recorder.step({
          kind: 'ERROR',
          title: `⚡ ${provider} cortado após falhas seguidas — plano B assume até ele voltar`,
          payload: { provider, erro: erroPrincipal },
        });
      }
      const planoB = escolherPlanoB(unit, !!env.OPENAI_API_KEY);
      if (planoB) {
        try {
          const modeloB = createChatModel(
            { ...unit, llmProvider: planoB.provider },
            { model: planoB.modelName, temperature: config.temperature, maxTokens: config.maxTokens },
          );
          const modeloBComTools = (
            tools.length > 0
              ? (modeloB as unknown as { bindTools: (t: unknown[]) => unknown }).bindTools(
                  planoB.provider === 'google' ? toolsParaGemini(tools) : tools,
                )
              : modeloB
          ) as unknown as Parameters<typeof invokeChatModel>[0]['model'];

          response = (await withTimeout(
            invokeChatModel({
              model: modeloBComTools,
              messages: finalMessages,
              unitId: unit.id,
              traceId: recorder.traceId,
              modelName: planoB.modelName,
              provider: planoB.provider,
              tools,
              conversaId: idDaConversa,
            }),
            PLANO_B_TIMEOUT_MS,
          )) as AIMessage;

          await recorder.step({
            kind: 'THINKING',
            title: `🔁 Plano B: ${planoB.provider} (${planoB.modelName}) respondeu no lugar do modelo principal`,
            payload: { erroPrincipal, planoB },
            latencyMs: Math.round(performance.now() - t0),
          });
        } catch (err2) {
          await recorder.step({
            kind: 'ERROR',
            title: '⏱️ IA indisponível — principal e plano B falharam',
            payload: {
              erroPrincipal,
              erroPlanoB: err2 instanceof Error ? err2.message : String(err2),
              planoB,
            },
            latencyMs: Math.round(performance.now() - t0),
          });
          return {
            messages: [new AIMessage(FALLBACK_INDISPONIVEL)],
            decision: FALLBACK_INDISPONIVEL,
          } satisfies Partial<AgentStateType>;
        }
      } else {
        await recorder.step({
          kind: 'ERROR',
          title: '⏱️ IA indisponível — sem plano B configurado, fallback enviado',
          payload: { erroPrincipal, timeoutMs: AGENT_NODE_TIMEOUT_MS },
          latencyMs: Math.round(performance.now() - t0),
        });
        return {
          messages: [new AIMessage(FALLBACK_INDISPONIVEL)],
          decision: FALLBACK_INDISPONIVEL,
        } satisfies Partial<AgentStateType>;
      }
    }
    const latency = Math.round(performance.now() - t0);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text = aiTextFromContent(response.content);
      await recorder.step({
        kind: 'THINKING',
        title: 'IA respondeu (sem tool call)',
        payload: { text },
        latencyMs: latency,
      });

      const guard = aplicarGuardrail(text, unit);
      if (guard.rewritten) {
        const ultimaIA = [...nonSystemMessages].reverse().find((m) => m.getType() === 'ai');
        const textoUltima = ultimaIA ? aiTextFromContent(ultimaIA.content) : '';
        const repetindo = normalizarResposta(textoUltima) === normalizarResposta(guard.text);

        if (repetindo) {
          await recorder.step({
            kind: 'ERROR',
            title: `🔁 Guardrail em LOOP (${guard.triggered.join(', ')}) — repetiria a mesma resposta; escalando`,
            payload: { original: text, reescrito: guard.text, motivos: guard.triggered },
          });
          response.content = FALLBACK_LOOP_GUARDRAIL;
        } else {
          response.content = guard.text;
          await recorder.step({
            kind: 'THINKING',
            title: `🛡️ Guardrail reescreveu a resposta (${guard.triggered.join(', ')})`,
            payload: { original: text, reescrito: guard.text, motivos: guard.triggered },
          });
        }
      }

      if (kommoClient && unit.collectNameEnabled && userMessage && state.leadId) {
        const lastAssistant = [...nonSystemMessages].reverse().find((m) => m.getType() === 'ai');
        const lastAssistantText = lastAssistant
          ? typeof lastAssistant.content === 'string'
            ? lastAssistant.content
            : JSON.stringify(lastAssistant.content)
          : null;
        const detected = detectNameDisclosure(userMessage, {
          nameWasAsked: askedForName(lastAssistantText),
        });
        if (detected) {
          await maybeAutoUpdateLeadTitle({
            recorder,
            kommo: kommoClient,
            leadId: state.leadId,
            name: detected,
            tz: fusoDaUnidade(unit),
          });
        }
      }

      return { messages: [response], decision: guard.text } satisfies Partial<AgentStateType>;
    }

    return { messages: [response] } satisfies Partial<AgentStateType>;
  };

  const toolNode = new ToolNode(tools);

  const shouldContinue = (state: AgentStateType): 'tools' | typeof END => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    if (last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
      return 'tools';
    }
    return END;
  };

  const workflow = new StateGraph(AgentState)
    .addNode('agent', agentNode, { retryPolicy: { maxAttempts: 2 } })
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, {
      tools: 'tools',
      [END]: END,
    })
    .addEdge('tools', 'agent');

  const checkpointer = await getCheckpointer();
  const compiled = workflow.compile({ checkpointer });

  return compiled;
}

async function maybeAutoUpdateLeadTitle({
  recorder,
  kommo,
  leadId,
  name,
  tz,
}: {
  recorder: TraceRecorder;
  kommo: ReturnType<typeof createKommoClient>;
  leadId: number;
  name: string;
  tz: string;
}): Promise<void> {
  const t0 = performance.now();
  if (!looksLikeName(name)) {
    await recorder.step({
      kind: 'THINKING',
      title: `[safety-net] "${name}" não parece nome — captura descartada`,
      payload: { leadId, rejeitado: name },
      latencyMs: Math.round(performance.now() - t0),
    });
    return;
  }
  const display = titleCaseName(name);
  try {
    const lead = await kommo.getLead(leadId);
    const current = (lead.name ?? '').trim();
    const looksGeneric =
      current.length === 0 ||
      /^lead\s*#?\d+$/i.test(current) ||
      current.toLowerCase().includes(display.toLowerCase());
    if (!looksGeneric) {
      await recorder.step({
        kind: 'KOMMO_ACTION',
        title: `[safety-net] título do lead já está como "${current}" — não sobrescreve`,
        payload: { leadId, current, detected: display },
        latencyMs: Math.round(performance.now() - t0),
      });
      return;
    }
    const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const dateBR = new Intl.DateTimeFormat('pt-BR', {
      timeZone: tz,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(createdAtMs));
    const desired = `${display} ${dateBR}`;
    await kommo.updateLeadName(leadId, desired);
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `[safety-net] IA esqueceu de chamar atualizar_titulo_lead — corrigido: "${current}" → "${desired}"`,
      payload: { leadId, previous: current, desired, name: display, dateBR },
      latencyMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recorder.step({
      kind: 'ERROR',
      title: `[safety-net] falha ao atualizar título automaticamente: ${msg}`,
      payload: { leadId, name: display, error: msg },
      latencyMs: Math.round(performance.now() - t0),
    });
  }
}

const ENTRY_DATE_TAG_SLUGS = new Set(['advocacia-magalhaes']);

async function maybeAddEntryDateTag({
  recorder,
  kommo,
  leadId,
  tz,
}: {
  recorder: TraceRecorder;
  kommo: ReturnType<typeof createKommoClient>;
  leadId: number;
  tz: string;
}): Promise<void> {
  const t0 = performance.now();
  try {
    const lead = await kommo.getLead(leadId);
    const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const dateTag = new Intl.DateTimeFormat('pt-BR', {
      timeZone: tz,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(createdAtMs));
    await kommo.addTag({ leadId, tag: dateTag });
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `tag de data de entrada aplicada: "${dateTag}"`,
      payload: { leadId, dateTag },
      latencyMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recorder.step({
      kind: 'ERROR',
      title: `falha ao aplicar tag de data de entrada: ${msg}`,
      payload: { leadId, error: msg },
      latencyMs: Math.round(performance.now() - t0),
    });
  }
}
