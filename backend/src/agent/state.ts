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

  traceId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
});

export type AgentStateType = typeof AgentState.State;
