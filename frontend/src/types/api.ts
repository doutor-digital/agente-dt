// Tipos compartilhados com o backend. Mantidos manualmente — em produção
// valeria gerar via openapi ou tRPC.

export type StepKind =
  | 'WEBHOOK_RECEIVED'
  | 'THINKING'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'KOMMO_ACTION'
  | 'META_ACTION'
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
  unitId: string | null;
  channel: string;
  status: TraceStatus;
  latencyMs: number | null;
  createdAt: string;
  iaDecision: unknown;
}

export interface LlmCallSummary {
  id: string;
  unitId: string | null;
  traceId: string | null;
  provider: string;
  model: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  status: 'success' | 'error';
  errorMessage?: string | null;
  createdAt: string;
}

export interface LlmCallDetail extends LlmCallSummary {
  requestBody: unknown;
  responseBody: unknown;
}

export interface TraceDetail extends TraceSummary {
  input: unknown;
  errorMessage: string | null;
  steps: ExecutionStep[];
  llmCalls: Pick<
    LlmCallSummary,
    'id' | 'model' | 'endpoint' | 'promptTokens' | 'completionTokens' | 'totalTokens' | 'costUsd' | 'latencyMs' | 'status' | 'createdAt'
  >[];
  unit: { id: string; slug: string; name: string } | null;
}

export interface Stats {
  total: number;
  success: number;
  failed: number;
  running: number;
  successRate: number;
  avgLatencyMs: number;
  llm: {
    calls: number;
    totalTokens: number;
    costUsd: number;
  };
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

export interface Unit {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  kommoSubdomain: string | null;
  kommoAccessToken: string | null;
  kommoSalesbotId: number | null;
  kommoReplyFieldId: number | null;
  kommoPausedFieldId: number | null;
  kommoWonStatusIds: number[];
  openaiApiKey: string | null;
  openaiAdminKey: string | null;
  openaiModel: string;
  openaiAssistantId: string | null;
  openaiTemperature: number;
  openaiMaxTokens: number;
  openaiMonthlyBudgetUsd: number | string;
  metaPhoneNumberId: string | null;
  metaAccessToken: string | null;
  metaVerifyToken: string | null;
  metaAppSecret: string | null;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
  _hasSecrets?: Record<string, boolean>;
}

export type UnitInput = Partial<Omit<Unit, 'id' | 'createdAt' | 'updatedAt' | '_hasSecrets'>> & {
  slug: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Kommo Explorer — dados ao vivo do CRM Kommo (campos, salesbots, pipelines)
// ---------------------------------------------------------------------------

export interface KommoErrorEnvelope {
  error?: string;
  kommoStatus?: number | null;
  kommoBody?: unknown;
}

export interface KommoFieldsResponse extends KommoErrorEnvelope {
  ok: boolean;
  fields?: Array<{ id: number; name: string; type: string; code: string | null }>;
}

export interface KommoSalesbotsResponse extends KommoErrorEnvelope {
  ok: boolean;
  bots?: Array<{ id: number; name: string }>;
}

export interface KommoPipelinesResponse extends KommoErrorEnvelope {
  pipelines?: Array<{
    id: number;
    name: string;
    isMain: boolean;
    isArchive: boolean;
    statuses: Array<{ id: number; name: string; color: string | null }>;
  }>;
  message?: string;
}

export interface KommoValidateResponse {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Integrations / Alerts
// ---------------------------------------------------------------------------

export type CardStatus = 'ok' | 'warning' | 'danger' | 'idle';

export interface OpenAIIntegrationCard {
  configured: boolean;
  status: CardStatus;
  apiKey: {
    configured: boolean;
    reachable: boolean | null;
    modelCount: number | null;
    sampleModels: string[];
    error?: string;
  };
  adminKey: { configured: boolean; usable: boolean | null; error?: string };
  assistantId: string | null;
  model: string;
  platform: null | {
    sinceDays: number;
    totalCostUsd: number;
    todayCostUsd: number;
    last7DaysCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    numRequests: number;
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; numRequests: number }>;
    timeline: Array<{ date: string; costUsd: number; tokens: number; requests: number }>;
    projects?: Array<{ id: string; name: string; status: string }>;
  };
  measured: {
    sinceDays: number;
    totalCostUsd: number;
    last7DaysCostUsd: number;
    todayCostUsd: number;
    totalTokens: number;
    numCalls: number;
    byModel: Array<{ model: string; calls: number; totalTokens: number; costUsd: number }>;
    timeline: Array<{ date: string; costUsd: number; tokens: number; calls: number }>;
  };
  agentShare: null | { percentOfRequests: number; percentOfCost: number };
  budget: {
    monthlyUsd: number;
    spentUsd: number;
    spentSource: 'platform' | 'measured';
    pctUsed: number;
    remainingUsd: number;
    daysIntoMonth: number;
    projectedMonthUsd: number;
    alert: 'ok' | 'warning' | 'danger' | 'over';
  };
  alerts: string[];
}

export interface KommoIntegrationCard {
  configured: boolean;
  status: CardStatus;
  subdomain: string | null;
  reachable: boolean | null;
  account: null | { id?: number; name?: string; subdomain?: string };
  error?: string;
  alerts: string[];
}

export interface MetaIntegrationCard {
  configured: boolean;
  status: CardStatus;
  phoneNumberId: string | null;
  hasAccessToken: boolean;
  hasVerifyToken: boolean;
  hasAppSecret: boolean;
  webhookUrl: string;
  alerts: string[];
}

export interface IntegrationsResponse {
  unit: { id: string; slug: string; name: string };
  generatedAt: string;
  openai: OpenAIIntegrationCard;
  kommo: KommoIntegrationCard;
  meta: MetaIntegrationCard;
  alerts: Array<{ severity: 'info' | 'warning' | 'danger'; integration: string; message: string }>;
}

export interface GlobalAlert {
  unitId: string;
  unitSlug: string;
  unitName: string;
  severity: 'warning' | 'danger';
  integration: string;
  message: string;
}

export interface UnitStats {
  sinceDays: number;
  traces: {
    total: number;
    success: number;
    failed: number;
    running: number;
    successRate: number;
    avgLatencyMs: number;
  };
  llm: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    avgLatencyMs: number;
    byModel: { model: string; calls: number; totalTokens: number; costUsd: number }[];
  };
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  id: string;
  unitId: string;
  leadId: string;
  contactName: string | null;
  phone: string | null;
  channel: string;
  lastMessageAt: string;
  createdAt: string;
  _count: { messages: number };
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  traceId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  unitId: string;
  leadId: string;
  contactName: string | null;
  phone: string | null;
  channel: string;
  lastMessageAt: string;
  createdAt: string;
  messages: ConversationMessage[];
  unit: { id: string; slug: string; name: string };
}

// ---------------------------------------------------------------------------
// AgentConfig
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
  unitId: string | null;
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

// ---------------------------------------------------------------------------
// Prompt performance / LLM-as-judge
// ---------------------------------------------------------------------------

export interface JudgeScores {
  clareza: number;
  empatia: number;
  objecoes: number;
  cta: number;
  tom: number;
}

export interface JudgeCriterion {
  key: keyof JudgeScores;
  label: string;
  desc: string;
}

export interface PromptPerformanceItem {
  promptHash: string;
  promptSnapshot: string;
  conversions: number;
  evaluations: number;
  avgScores: JudgeScores;
  avgOverall: number;
  totalCostUsd: number;
  firstSeen: string;
  lastSeen: string;
  topEvaluations: Array<{
    conversationId: string;
    leadId: string;
    contactName: string | null;
    convertedAt: string | null;
    overallScore: number;
    scores: JudgeScores;
    verdict: string;
  }>;
}

export interface PromptPerformanceResponse {
  sinceDays: number;
  totals: {
    conversations: number;
    converted: number;
    evaluated: number;
    pendingJudge: number;
    conversionRate: number;
  };
  criteria: JudgeCriterion[];
  prompts: PromptPerformanceItem[];
}

export interface ConversationEvaluationResponse {
  evaluation: {
    id: string;
    conversationId: string;
    unitId: string;
    promptHash: string;
    promptSnapshot: string;
    model: string;
    scores: JudgeScores;
    overallScore: number;
    verdict: string;
    costUsd: number;
    latencyMs: number;
    createdAt: string;
  };
  criteria: JudgeCriterion[];
}

export interface OpenAIDebugResponse {
  adminKey: { configured: boolean; preview?: string };
  message?: string;
  diagnosis?: { conclusion: string; severity: 'ok' | 'warning' | 'danger' };
  calls?: {
    costs: { path: string; ok: boolean; status: number | null; body: unknown; error?: string };
    usage: { path: string; ok: boolean; status: number | null; body: unknown; error?: string };
    projects: { path: string; ok: boolean; status: number | null; body: unknown; error?: string };
  };
}

export type AgentConfigInput = {
  unitId?: string | null;
  systemPrompt: string;
  tools: ToolConfig[];
  workflow: WorkflowRule[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
};
