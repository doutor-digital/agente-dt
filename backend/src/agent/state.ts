// ============================================================================
// state.ts — Definição do State do grafo (LangGraph Annotation).
//
// LÓGICA DE ENGENHARIA
// --------------------
// O State é o objeto que TRANSITA entre os nós do grafo. Cada nó recebe
// o State atual e retorna um delta (atualização parcial). O LangGraph
// aplica os reducers definidos em cada campo para mesclar.
//
// Campos do nosso State:
//
//  - messages:    histórico de mensagens da conversa (LLM <-> tools).
//                 Reducer = concat (cada nó adiciona novas mensagens).
//                 Esse é o canal padrão do "ReAct loop" do LangGraph.
//
//  - leadId:      ID do lead Kommo. Imutável durante a execução.
//
//  - leadSnapshot: estado do lead lido do Kommo no início (tags atuais,
//                 etapa atual). Usado pela LLM para tomar decisão.
//
//  - decision:    string livre que o agente preenche ao decidir
//                 (ex: "Aplicar tag Quente"). Útil para o dashboard.
//
//  - traceId:     ID do ExecutionTrace no nosso Postgres. NÃO é o
//                 thread_id do checkpoint — são conceitos distintos:
//                 * thread_id  = conversa contínua (lead 123 conversa N vezes)
//                 * trace_id   = uma execução pontual do grafo
//
// PERSISTÊNCIA / CHECKPOINTING
// ----------------------------
// Quando rodamos o grafo com PostgresSaver, o State INTEIRO é serializado
// e gravado a cada nó. Se a próxima invocação do grafo usar o mesmo
// `thread_id`, o State é reidratado — o agente "lembra" do contexto.
// Por isso o `leadId` e as `messages` ficam dentro do State (e não como
// parâmetros soltos do invoke).
// ============================================================================

import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';

export const AgentState = Annotation.Root({
  /**
   * Histórico de mensagens. O reducer `messagesStateReducer` é o canônico do
   * LangGraph: faz concat respeitando IDs para upsert de mensagens parciais
   * (streaming) e mantém ordem cronológica.
   */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /** ID do lead Kommo — imutável durante a execução. */
  leadId: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /** Snapshot do lead lido do Kommo (tags, etapa, etc). */
  leadSnapshot: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** Resumo textual da decisão do agente para o dashboard. */
  decision: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** ID do ExecutionTrace no nosso Postgres (não é o thread_id do checkpoint). */
  traceId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
});

export type AgentStateType = typeof AgentState.State;
