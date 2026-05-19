// ============================================================================
// graph.ts — Grafo de decisão do agente (LangGraph, multi-tenant).
//
// LÓGICA DE ENGENHARIA — O FLUXO DO STATE
// ---------------------------------------
//
//                    ┌────────────────┐
//                    │   START        │
//                    └────────┬───────┘
//                             │ (State inicial:
//                             │  leadId, messages=[HumanMessage], traceId)
//                             ▼
//                    ┌────────────────┐
//                    │   agent (LLM)  │  ← chama OpenAI da Unit corrente
//                    └────────┬───────┘
//                             │ (LLM responde com:
//                             │   • tool_calls → vai pra tools
//                             │   • texto puro → vai pro END)
//                             ▼
//                    ┌────────────────┐
//                    │ shouldContinue?│
//                    └───┬────────┬───┘
//                  tools │        │ end
//                        ▼        ▼
//                   ┌─────────┐  END
//                   │  tools  │  ← executa tool no Kommo da Unit
//                   └────┬────┘
//                        └────────► agent (loop ReAct)
//
// MULTI-TENANT
// ------------
// `buildAgentGraph(recorder, unit)` recebe a Unit. Toda chamada de LLM e
// tool usa as credenciais da Unit. O `traceId` da execução fica no recorder
// pra que `invokeChatModel` consiga associar cada LlmCall ao trace correto.
//
// CHECKPOINTING / MEMÓRIA DE CONVERSA
// -----------------------------------
// `thread_id = "unit-{slug}-lead-{leadId}"` — separa histórico por Unit, pra
// que duas unidades nunca compartilhem memória de lead acidentalmente.
// ============================================================================

import { type AIMessage, type BaseMessage, SystemMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Unit } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { AgentState, type AgentStateType } from './state.js';
import { buildTools } from './tools.js';
import { TraceRecorder } from './trace-recorder.js';
import { getActiveConfig, renderWorkflowGuidance } from './config.js';
import { composeSystemPromptForUnit } from './prompt-composer.js';
import { createKommoClient } from '../services/kommo.service.js';
import { createChatOpenAI, invokeChatModel } from '../services/openai.service.js';

// ---------------------------------------------------------------------------
// Checkpointer (singleton).
// O PostgresSaver mantém um pool TCP próprio. Criamos UMA instância e
// reusamos. `setup()` cria as tabelas se ainda não existirem.
// ---------------------------------------------------------------------------

let checkpointerInstance: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (checkpointerInstance) return checkpointerInstance;
  const cp = PostgresSaver.fromConnString(env.DATABASE_URL);
  await cp.setup();
  checkpointerInstance = cp;
  logger.info('PostgresSaver pronto');
  return cp;
}

// ---------------------------------------------------------------------------
// Constrói o thread_id estável da Unit/Lead.
// Inclui slug pra evitar colisão entre unidades.
// ---------------------------------------------------------------------------
export function buildThreadId(unitSlug: string, leadId: string | number): string {
  return `unit-${unitSlug}-lead-${leadId}`;
}

// ---------------------------------------------------------------------------
// Construção do grafo.
//
// Recebe a `Unit` (credenciais + assistant_id + system prompt) e o
// `recorder` (vinculado ao ExecutionTrace). Retorna o grafo compilado
// pronto pra `invoke`.
// ---------------------------------------------------------------------------

export async function buildAgentGraph(recorder: TraceRecorder, unit: Unit) {
  const config = await getActiveConfig(unit.id);

  // 1) Tools com descriptions editadas pelo dashboard, instanciadas com o
  //    KommoClient da Unit.
  const toolConfigByName = new Map(config.tools.map((t) => [t.name, t]));
  const descriptionOverrides: Record<string, string> = {};
  for (const [name, cfg] of toolConfigByName) {
    if (cfg.description) descriptionOverrides[name] = cfg.description;
  }

  // Só monta o KommoClient se a Unit tiver credenciais. Se não tiver,
  // ainda dá pra rodar o agente em modo "só conversa" (sem tools Kommo).
  let kommoClient: ReturnType<typeof createKommoClient> | null = null;
  try {
    kommoClient = createKommoClient(unit);
  } catch (err) {
    logger.warn({ err, unit: unit.slug }, 'Unit sem credenciais Kommo — tools desabilitadas');
  }

  const allTools = kommoClient
    ? buildTools({
        recorder,
        kommo: kommoClient,
        descriptionOverrides,
        pausedFieldId: unit.kommoPausedFieldId,
      })
    : [];

  // Filtra tools desabilitadas no AgentConfig.
  const tools = allTools.filter((t) => {
    const cfg = toolConfigByName.get(t.name);
    return cfg ? cfg.enabled : true;
  });

  // 2) System prompt — agora usa o composer, que mescla:
  //    - Persona/base text (AgentConfig.systemPrompt > Unit.systemPrompt > auto)
  //    - Blocos das features ativadas no wizard da Unit (qualificação, handoff,
  //      pipeline-by-intent, coleta de contato, cupom, horário, follow-up)
  //    - Regras estruturadas (renderWorkflowGuidance)
  const systemPrompt = await composeSystemPromptForUnit({
    unit,
    agentConfigPrompt: config.systemPrompt,
    workflowText: renderWorkflowGuidance(config.workflow),
  });

  // 3) Modelo OpenAI da Unit.
  const modelName = config.model || unit.openaiModel || env.OPENAI_MODEL;
  const baseModel = createChatOpenAI(unit, {
    model: modelName,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });
  // bindTools retorna um Runnable, não ChatOpenAI — passamos via interface
  // mínima `InvokableModel` que `invokeChatModel` aceita.
  // Cast pra interface mínima — `bindTools` devolve um Runnable que não
  // bate com o tipo estrito do ChatOpenAI, mas a forma de `.invoke(messages, opts)`
  // é a mesma e é o que `invokeChatModel` precisa.
  const model = (tools.length > 0 ? baseModel.bindTools(tools) : baseModel) as unknown as Parameters<
    typeof invokeChatModel
  >[0]['model'];

  // -------------------------------------------------------------------------
  // NODE: agent
  // -------------------------------------------------------------------------
  const agentNode = async (state: AgentStateType) => {
    await recorder.step({
      kind: 'THINKING',
      title: 'IA analisando intenção',
      payload: { model: modelName, msgCount: state.messages.length, unit: unit.slug },
    });

    // SEMPRE usa o systemPrompt atual da Unit, NUNCA o que está no checkpoint.
    // Se o usuário edita o prompt no painel, queremos que a próxima execução
    // dessa Conversa já use a nova versão. Por isso filtramos qualquer
    // SystemMessage antiga que o PostgresSaver tenha persistido e prependamos
    // a atual. Sem isso, conversas existentes ficam presas no prompt antigo
    // pra sempre.
    const nonSystemMessages = state.messages.filter((m) => m.getType() !== 'system');
    const finalMessages: BaseMessage[] = [new SystemMessage(systemPrompt), ...nonSystemMessages];

    const t0 = performance.now();
    const response = (await invokeChatModel({
      model,
      messages: finalMessages,
      unitId: unit.id,
      traceId: recorder.traceId,
      modelName,
      tools,
    })) as AIMessage;
    const latency = Math.round(performance.now() - t0);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text =
        typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      await recorder.step({
        kind: 'THINKING',
        title: 'IA respondeu (sem tool call)',
        payload: { text },
        latencyMs: latency,
      });
      return { messages: [response], decision: text } satisfies Partial<AgentStateType>;
    }

    return { messages: [response] } satisfies Partial<AgentStateType>;
  };

  // -------------------------------------------------------------------------
  // NODE: tools (ToolNode do LangGraph)
  // -------------------------------------------------------------------------
  const toolNode = new ToolNode(tools);

  // -------------------------------------------------------------------------
  // EDGE condicional: shouldContinue
  // -------------------------------------------------------------------------
  const shouldContinue = (state: AgentStateType): 'tools' | typeof END => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    if (last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
      return 'tools';
    }
    return END;
  };

  // -------------------------------------------------------------------------
  // Montagem do grafo.
  // -------------------------------------------------------------------------
  const workflow = new StateGraph(AgentState)
    .addNode('agent', agentNode)
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
