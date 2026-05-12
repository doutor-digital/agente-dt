// Tipos compartilhados com o backend. Mantidos manualmente — em produção
// valeria gerar via openapi ou tRPC.

export type StepKind =
  | 'WEBHOOK_RECEIVED'
  | 'THINKING'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'KOMMO_ACTION'
  | 'COMPLETED'
  | 'ERROR';

export type TraceStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface ExecutionStep {
  id: string;
  traceId: string;
  sequence: number;
  kind: StepKind;
  title: string;
  payload: unknown;
  latencyMs: number | null;
  createdAt: string;
}

export interface TraceSummary {
  id: string;
  threadId: string;
  leadId: string;
  status: TraceStatus;
  latencyMs: number | null;
  createdAt: string;
  iaDecision: unknown;
}

export interface TraceDetail extends TraceSummary {
  input: unknown;
  errorMessage: string | null;
  steps: ExecutionStep[];
}

export interface Stats {
  total: number;
  success: number;
  failed: number;
  running: number;
  successRate: number;
  avgLatencyMs: number;
}

// ---------------------------------------------------------------------------
// AgentConfig — editado pelo painel "Configuração".
// ---------------------------------------------------------------------------

export interface ToolConfig {
  name: string;
  enabled: boolean;
  description: string;
}

export interface WorkflowRule {
  id: string;
  when: string;
  then: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  isActive: boolean;
  systemPrompt: string;
  tools: ToolConfig[];
  workflow: WorkflowRule[];
  model: string;
  temperature: number;
  maxTokens: number;
  updatedAt: string;
}

export interface AgentConfigResponse {
  config: AgentConfig;
  knownTools: string[];
  defaults: {
    systemPrompt: string;
    tools: ToolConfig[];
  };
}

export type AgentConfigInput = {
  systemPrompt: string;
  tools: ToolConfig[];
  workflow: WorkflowRule[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
};
