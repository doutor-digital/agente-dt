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
// SystemLog — painel "Erros" (warn/error/fatal persistidos)
// ---------------------------------------------------------------------------

export type LogLevel = 'WARN' | 'ERROR' | 'FATAL';

export interface SystemLog {
  id: string;
  level: LogLevel;
  module: string | null;
  msg: string;
  context: unknown;
  unitId: string | null;
  traceId: string | null;
  createdAt: string;
}

export interface SystemLogListResponse {
  logs: SystemLog[];
  counts: Record<LogLevel, number>;
}

export interface SystemLogQuery {
  level?: LogLevel;
  module?: string;
  q?: string;
  since?: string; // ISO date
  limit?: number;
}

// ---------------------------------------------------------------------------
// LeadFieldRule — captura de dados em custom fields do Kommo via tools dinâmicas
// ---------------------------------------------------------------------------

export type KommoFieldType =
  | 'text'
  | 'textarea'
  | 'numeric'
  | 'date'
  | 'birthday'
  | 'select'
  | 'multiselect'
  | 'radiobutton';

export interface KommoLeadCustomField {
  id: number;
  name: string;
  type: KommoFieldType;
  code: string | null;
  enums: Array<{ id: number; value: string }>;
}

export interface KommoLeadCustomFieldsResponse {
  ok: boolean;
  fields?: KommoLeadCustomField[];
  error?: string;
  message?: string;
  kommoStatus?: number | null;
  kommoBody?: unknown;
}

export interface LeadFieldRule {
  id: string;
  unitId: string;
  kommoFieldId: number;
  kommoFieldName: string;
  kommoFieldType: KommoFieldType;
  kommoFieldEnums: Array<{ id: number; value: string }> | null;
  toolName: string;
  instruction: string;
  valueHint: string | null;
  examples: string[];
  enabled: boolean;
  updatesLeadTitle: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LeadFieldRuleInput {
  kommoFieldId: number;
  kommoFieldName: string;
  kommoFieldType: KommoFieldType;
  kommoFieldEnums?: Array<{ id: number; value: string }> | null;
  toolName: string;
  instruction: string;
  valueHint?: string | null;
  examples?: string[];
  enabled?: boolean;
  updatesLeadTitle?: boolean;
}

// ---------------------------------------------------------------------------
// Auth — user logado no painel
// ---------------------------------------------------------------------------

export type UserRole = 'SUPER_ADMIN' | 'UNIT_ADMIN';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  role: UserRole;
  unitId: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  role: UserRole;
  unitId: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminUserInput {
  email: string;
  name?: string | null;
  role: UserRole;
  unitId?: string | null;
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
  kommoBypassSalesbot: boolean;
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
  metaWabaId: string | null;
  metaMonthlyBudgetUsd: number | string;
  systemPrompt: string;
  /** Categoria/segmento — seleciona o preset de persona (ex: "saude", "energia_solar"). */
  category: string | null;

  // Wizard fields
  personaCompanyName: string | null;
  personaTone: 'casual' | 'formal' | 'friendly' | null;
  personaGreeting: string | null;
  personaResponseLength: 'curta' | 'normal' | 'detalhada';
  personaLanguage: 'pt-BR' | 'en-US' | 'es-ES' | 'fr-FR';
  personaResponseDelaySec: number;
  personaEmojis: string[];
  personaEmojiFrequency: 'low' | 'normal' | 'high';
  qualificationEnabled: boolean;
  qualificationHotTag: string;
  qualificationColdTag: string;
  handoffEnabled: boolean;
  handoffKeywords: string[];
  pipelineIntents: Record<string, number> | null;
  contactCollectionEnabled: boolean;
  contactCollectionAfterTurns: number;
  welcomeCouponEnabled: boolean;
  welcomeCouponMessage: string | null;
  businessHoursEnabled: boolean;
  businessHoursStart: number;
  businessHoursEnd: number;
  businessHoursDays: string[];
  businessHoursTimezone: string;
  outOfHoursMessage: string | null;

  // Fontes (aba Fontes do painel da IA — 3 docs longos que entram no prompt).
  sourcePapel: string | null;
  sourceProdutos: string | null;
  sourceNegocio: string | null;
  followUpEnabled: boolean;
  followUpAfterHours: number;
  followUpMessage: string | null;

  collectNameEnabled: boolean;
  collectSourceEnabled: boolean;
  collectSourceOptions: string[];

  /** Campo customizado do Kommo onde o resumo da IA (resumir_lead_para_sdr) é
   *  gravado, além da nota interna. NULL = só nota. */
  summaryCustomFieldId: number | null;
  summaryCustomFieldName: string | null;

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

export interface KommoTagsResponse extends KommoErrorEnvelope {
  ok: boolean;
  tags?: Array<{ id: number; name: string; color: string | null }>;
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

export type LeadsBucket =
  | 'unanswered'
  | 'weekend_leads'
  | 'weekend_conversations'
  | 'handoff'
  | 'converted_ia'
  | 'converted_sdr';

export interface LeadsBucketItem {
  conversationId: string;
  leadId: string;
  contactName: string | null;
  phone: string | null;
  lastMessageAt: string;
  createdAt: string;
  convertedAt?: string | null;
  hint?: string | null;
}

export interface LeadsBucketResponse {
  bucket: LeadsBucket;
  periodDays: number;
  count: number;
  items: LeadsBucketItem[];
}

export interface KommoValidateResponse {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface MetaValidateResponse {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface MetaValidateInput {
  metaWabaId?: string | null;
  metaAccessToken?: string | null;
  metaPhoneNumberId?: string | null;
}

export interface DashboardResponse {
  periodDays: number;
  kpis: {
    uniqueLeads: number;
    answeredConversations: number;
    weekendLeads: number;
    weekendConversations: number;
    handoffCount: number;
    handoffRate: number;
    avgResponseLatencyMs: number;
    unansweredQuestions: number;
    convertedCount: number;
    conversionRate: number;
    // Split SDR (humano fechou após pausar_ia) vs IA (IA fechou sozinha).
    convertedByIa: number;
    convertedBySdr: number;
    conversionRateIa: number;
    conversionRateSdr: number;
    llmCostUsd: number;
    llmCallsCount: number;
    peakHour: number | null;
  };
  funnel: Array<{
    pipelineId: number;
    pipelineName: string;
    statuses: Array<{
      statusId: number;
      statusName: string;
      count: number;
      color: string | null;
    }>;
  }>;
  /** KPIs do período anterior (mesma duração, imediatamente antes). Subset. */
  previousKpis: {
    uniqueLeads: number;
    answeredConversations: number;
    convertedCount: number;
    llmCostUsd: number;
  };
  /** Mensagens DO PACIENTE agrupadas por canal. */
  messagesByChannel: Array<{
    channel: string;
    label: string;
    count: number;
  }>;
  /** Série temporal diária — 1 entrada por dia do período (zeros preenchidos). */
  dailySeries: Array<{
    date: string; // YYYY-MM-DD
    messages: number;
    conversations: number;
  }>;
}

/** Resposta do GET /dashboard — agregado de todas as unidades acessíveis. */
export interface AggregateUnitRow {
  id: string;
  name: string;
  slug: string;
  category: string | null;
  uniqueLeads: number;
  answeredConversations: number;
  newConversations: number;
  convertedCount: number;
  conversionRate: number;
  llmCostUsd: number;
  llmCallsCount: number;
}

export interface AggregateDashboardResponse {
  periodDays: number;
  totals: {
    uniqueLeads: number;
    answeredConversations: number;
    newConversations: number;
    convertedCount: number;
    conversionRate: number;
    llmCostUsd: number;
    llmCallsCount: number;
  };
  units: AggregateUnitRow[];
  messagesByChannel: Array<{ channel: string; label: string; count: number }>;
  dailySeries: Array<{ date: string; messages: number; conversations: number }>;
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
  wabaId: string | null;
  hasAccessToken: boolean;
  webhookUrl: string;
  cost: null | {
    monthSpentUsd: number;
    monthVolume: number;
    todayCostUsd: number;
    todayVolume: number;
    last7DaysCostUsd: number;
    last7DaysVolume: number;
    byCategory: Array<{ pricingCategory: string; volume: number; costUsd: number }>;
    lastSyncedAt: string | null;
  };
  budget: {
    monthlyUsd: number;
    spentUsd: number;
    pctUsed: number;
    remainingUsd: number;
    daysIntoMonth: number;
    projectedMonthUsd: number;
    alert: 'ok' | 'warning' | 'danger' | 'over';
  };
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

// ---------------------------------------------------------------------------
// WhatsApp cost (Meta pricing_analytics + template_analytics)
// ---------------------------------------------------------------------------

export interface WhatsappCostsResponse {
  unit: { id: string; slug: string; name: string; wabaId: string | null };
  range: { from: string; to: string };
  totals: { volume: number; costUsd: number; currency: string; rowsCount: number };
  byCategory: Array<{ pricingCategory: string; volume: number; costUsd: number }>;
  byType: Array<{ pricingType: string; volume: number; costUsd: number }>;
  byCountry: Array<{ country: string; volume: number; costUsd: number }>;
  timeline: Array<{ date: string; volume: number; costUsd: number }>;
  budget: {
    monthlyUsd: number;
    spentUsd: number;
    pctUsed: number;
    remainingUsd: number;
    daysIntoMonth: number;
    projectedMonthUsd: number;
    alert: 'ok' | 'warning' | 'danger' | 'over';
  };
  lastSyncedAt: string | null;
}

export interface WhatsappTemplateRow {
  templateId: string;
  templateName: string | null;
  language: string;
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  costUsd: number;
  deliveryRate: number;
  readRate: number;
  clickRate: number;
}

export interface WhatsappTemplatesResponse {
  unit: { id: string; slug: string; name: string };
  range: { from: string; to: string };
  totals: { sent: number; delivered: number; read: number; clicked: number; costUsd: number };
  templates: WhatsappTemplateRow[];
}

export interface WhatsappSyncResult {
  unitId: string;
  unitSlug: string;
  ok: boolean;
  pricingRowsUpserted: number;
  templateRowsUpserted: number;
  totalCostUsd: number;
  totalVolume: number;
  errors: string[];
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
  flagged?: boolean;
  createdAt: string;
}

export interface MessageTemplate {
  id: string;
  unitId: string;
  name: string;
  triggerKeywords: string[];
  response: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntry {
  id: string;
  unitId: string;
  question: string;
  answer: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlaggedMessage {
  id: string;
  content: string;
  createdAt: string;
  conversationId: string;
  conversation: { contactName: string | null; leadId: string };
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

export interface AgentConfig {
  id: string;
  unitId: string | null;
  name: string;
  isActive: boolean;
  systemPrompt: string;
  tools: ToolConfig[];
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
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

// ---------------------------------------------------------------------------
// Ações estruturadas — regras "quando → faça" cadastradas por Unit.
// ---------------------------------------------------------------------------

export type ActionKind =
  | 'add_tag'
  | 'move_stage'
  | 'transfer_with_permission'
  | 'transfer_without_permission'
  | 'summarize_to_note'
  | 'send_message'
  | 'respond_with_intent'
  | 'create_task'
  | 'assign_responsible'
  | 'remove_tag'
  | 'set_lead_value'
  | 'mark_lead_status'
  | 'move_pipeline'
  | 'pause_ai'
  | 'pause_in_stages';

export interface KommoUsersResponse {
  ok: boolean;
  users?: Array<{ id: number; name: string; email: string | null }>;
  error?: string;
  message?: string;
}

export interface KommoLossReasonsResponse {
  ok: boolean;
  reasons?: Array<{ id: number; name: string }>;
  error?: string;
  message?: string;
}

/** Uma ação dentro de uma regra (várias podem rodar juntas). */
export interface ActionStep {
  kind: ActionKind;
  params: Record<string, unknown>;
}

export interface UnitAction {
  id: string;
  unitId: string;
  conditionDescription: string;
  /** Formato canônico: lista de ações. */
  actions: ActionStep[];
  /** @deprecated mantido pra compatibilidade. */
  actionKind: ActionKind;
  /** @deprecated mantido pra compatibilidade. */
  actionParams: Record<string, unknown>;
  notes: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UnitActionInput {
  conditionDescription: string;
  actions: ActionStep[];
  notes?: string | null;
  enabled?: boolean;
}
