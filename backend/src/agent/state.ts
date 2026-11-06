import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  leadId: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  leadSnapshot: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  decision: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * A Sofia ficou calada de propósito neste turno (despedida-humano.ts): o paciente não leu nada e a equipe foi avisada. Quem
   * invoca o grafo manda `silencio: false` na entrada de CADA turno — o checkpoint guarda o estado entre turnos e sem isso o
   * valor do turno anterior vazaria.
   */
  silencio: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  traceId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
});

export type AgentStateType = typeof AgentState.State;
