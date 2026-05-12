// ============================================================================
// graph.ts — Grafo de decisão do agente (LangGraph).
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
//                    │   agent (LLM)  │  ← chama Claude com tools bound
//                    └────────┬───────┘
//                             │ (LLM responde com:
//                             │   • tool_calls → vai pra tools
//                             │   • texto puro → vai pro END)
//                             ▼
//                    ┌────────────────┐
//                    │ shouldContinue?│  (router edge condicional)
//                    └───┬────────┬───┘
//                  tools │        │ end
//                        ▼        ▼
//                   ┌─────────┐  END
//                   │  tools  │  ← executa tool, devolve ToolMessage
//                   └────┬────┘
//                        │ (volta pro agent — loop ReAct)
//                        └────────► agent
//
// Como o STATE TRANSITA:
//   1. Cliente invoca graph.invoke({leadId, messages:[HumanMessage(...)]},
//      {configurable:{thread_id}}).
//   2. PostgresSaver carrega checkpoint anterior (se houver) e mescla
//      com o input. Nosso `messagesStateReducer` faz concat.
//   3. Node "agent" chama o modelo. O retorno (AIMessage) é adicionado
//      ao State pelo reducer.
//   4. A edge condicional `shouldContinue` inspeciona a última mensagem:
//      - Tem `tool_calls`? → route="tools"
//      - Senão              → route="end"
//   5. Node "tools" (ToolNode) executa as tools chamadas, devolve
//      ToolMessages, que também são concatenadas no State.
//   6. Retorna pro "agent" — esse é o loop ReAct clássico.
//   7. A cada transição, PostgresSaver grava um checkpoint binário.
//
// CHECKPOINTING / MEMÓRIA DE CONVERSA
// -----------------------------------
// O `thread_id` é a chave da conversa. Para o nosso MVP usamos
// `thread_id = "lead-{leadId}"`. Isso significa que se o MESMO lead
// disparar webhooks múltiplos (ex: novo comentário, nova mensagem), o
// agente RETOMA a conversa anterior — não começa do zero. Toda a história
// de mensagens é reidratada do banco.
// ============================================================================

import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { AgentState, type AgentStateType } from './state.js';
import { buildTools } from './tools.js';
import { TraceRecorder } from './trace-recorder.js';
import { getActiveConfig, renderWorkflowGuidance } from './config.js';

// ---------------------------------------------------------------------------
// Checkpointer (singleton).
// O PostgresSaver mantém um pool TCP próprio. Criamos UMA instância e
// reusamos. `setup()` cria as tabelas se ainda não existirem — chamamos
// uma única vez no boot do servidor.
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
// Construção do grafo.
// Recebe um `recorder` porque as tools precisam dele. Como o recorder é
// específico de cada execução, retornamos uma função-factory que monta o
// grafo "pronto pra invocar".
//
// O system prompt, as tools habilitadas e as sequências de workflow vêm
// do AgentConfig (banco) — é a configuração editada pelo dashboard.
// Se o config ainda não foi semeado, getActiveConfig() cria o default.
// ---------------------------------------------------------------------------

export async function buildAgentGraph(recorder: TraceRecorder) {
  const config = await getActiveConfig();

  // Constrói as tools com as descriptions vindas do AgentConfig (descrições
  // editadas pelo usuário no dashboard).
  const toolConfigByName = new Map(config.tools.map((t) => [t.name, t]));
  const descriptionOverrides: Record<string, string> = {};
  for (const [name, cfg] of toolConfigByName) {
    if (cfg.description) descriptionOverrides[name] = cfg.description;
  }
  const allTools = buildTools(recorder, descriptionOverrides);

  // Filtra pelas habilitadas. Tool sem entry no config sai habilitada.
  const tools = allTools.filter((t) => {
    const cfg = toolConfigByName.get(t.name);
    return cfg ? cfg.enabled : true;
  });

  // System prompt + bloco de sequências (se houver).
  const systemPrompt = config.systemPrompt + renderWorkflowGuidance(config.workflow);

  // Modelo OpenAI. `bindTools` informa ao SDK quais ferramentas estão
  // disponíveis — isso vira o array `tools` da Chat Completions API.
  const model = new ChatOpenAI({
    apiKey: env.OPENAI_API_KEY,
    model: config.model || env.OPENAI_MODEL,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  }).bindTools(tools);

  // -------------------------------------------------------------------------
  // NODE: agent
  // Chama a LLM com o histórico atual de mensagens.
  // Antes da chamada, registra um step "THINKING" para o dashboard.
  // -------------------------------------------------------------------------
  const agentNode = async (state: AgentStateType) => {
    const t0 = performance.now();
    await recorder.step({
      kind: 'THINKING',
      title: 'IA analisando intenção',
      payload: { model: config.model || env.OPENAI_MODEL, msgCount: state.messages.length },
    });

    // Injeta o system na primeira chamada (a partir daí ele vive no
    // checkpoint e não precisa ser reenviado).
    const messages: BaseMessage[] = state.messages;
    const hasSystem = messages.some((m) => m.getType() === 'system');
    const finalMessages = hasSystem
      ? messages
      : ([{ role: 'system', content: systemPrompt } as unknown as BaseMessage, ...messages]);

    const response = (await model.invoke(finalMessages)) as AIMessage;
    const latency = Math.round(performance.now() - t0);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Resposta final (texto puro). Salvamos a decisão textual no state.
      const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
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
  // NODE: tools
  // ToolNode é um helper do LangGraph que pega a última AIMessage do State,
  // lê os `tool_calls`, executa as tools correspondentes (em paralelo se
  // houver várias), e devolve um array de ToolMessages.
  // -------------------------------------------------------------------------
  const toolNode = new ToolNode(tools);

  // -------------------------------------------------------------------------
  // EDGE condicional: shouldContinue
  // Decide se voltamos pras tools ou encerramos.
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
    // Depois de executar tools, volta pro agente decidir o próximo passo.
    // Esse é o loop ReAct — pode iterar várias vezes se a LLM encadear
    // tool_calls. O recursionLimit do invoke é a trava de segurança.
    .addEdge('tools', 'agent');

  const checkpointer = await getCheckpointer();
  const compiled = workflow.compile({ checkpointer });

  return compiled;
}
