import { AIMessage, type BaseMessage, SystemMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
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
import {
  withTimeout,
  AGENT_NODE_TIMEOUT_MS,
  FALLBACK_INDISPONIVEL,
  escolherPlanoB,
  PLANO_B_TIMEOUT_MS,
} from './llm-policy.js';

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

export async function buildAgentGraph(recorder: TraceRecorder, unit: Unit) {
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

  const tools = allTools.filter((t) => {
    const cfg = toolConfigByName.get(t.name);
    return cfg ? cfg.enabled : true;
  });

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
  const toolsParaModelo = useGoogle ? toolsParaGemini(tools) : tools;
  const model = (
    tools.length > 0
      ? (baseModel as unknown as { bindTools: (t: unknown[]) => unknown }).bindTools(toolsParaModelo)
      : baseModel
  ) as unknown as Parameters<typeof invokeChatModel>[0]['model'];

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
      void maybeAddEntryDateTag({ recorder, kommo: kommoClient, leadId: state.leadId });
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
    const finalMessages: BaseMessage[] = [systemMessage, ...nonSystemMessages];

    const t0 = performance.now();
    let response: AIMessage;
    try {
      response = (await withTimeout(
        invokeChatModel({
          model,
          messages: finalMessages,
          unitId: unit.id,
          traceId: recorder.traceId,
          modelName,
          provider,
          tools,
        }),
        AGENT_NODE_TIMEOUT_MS,
      )) as AIMessage;
    } catch (err) {
      const erroPrincipal = err instanceof Error ? err.message : String(err);
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
        response.content = guard.text;
        await recorder.step({
          kind: 'THINKING',
          title: `🛡️ Guardrail reescreveu a resposta (${guard.triggered.join(', ')})`,
          payload: { original: text, reescrito: guard.text, motivos: guard.triggered },
        });
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
}: {
  recorder: TraceRecorder;
  kommo: ReturnType<typeof createKommoClient>;
  leadId: number;
  name: string;
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
      timeZone: 'America/Sao_Paulo',
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
}: {
  recorder: TraceRecorder;
  kommo: ReturnType<typeof createKommoClient>;
  leadId: number;
}): Promise<void> {
  const t0 = performance.now();
  try {
    const lead = await kommo.getLead(leadId);
    const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const dateTag = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
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
