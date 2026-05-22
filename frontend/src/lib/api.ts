import axios from 'axios';
import type {
  AdminUser,
  AdminUserInput,
  AgentConfig,
  AgentConfigInput,
  AgentConfigResponse,
  AuthUser,
  ConversationDetail,
  ConversationEvaluationResponse,
  ConversationSummary,
  DashboardResponse,
  GlobalAlert,
  IntegrationsResponse,
  FlaggedMessage,
  KnowledgeEntry,
  KommoFieldsResponse,
  KommoPipelinesResponse,
  KommoSalesbotsResponse,
  KommoTagsResponse,
  KommoValidateResponse,
  LeadsBucket,
  LeadsBucketResponse,
  MessageTemplate,
  LlmCallDetail,
  UnitAction,
  UnitActionInput,
  LlmCallSummary,
  OpenAIDebugResponse,
  KommoLeadCustomFieldsResponse,
  LeadFieldRule,
  LeadFieldRuleInput,
  PromptPerformanceResponse,
  Stats,
  SystemLogListResponse,
  SystemLogQuery,
  TraceDetail,
  TraceSummary,
  Unit,
  UnitInput,
  UnitStats,
} from '../types/api';

// Em dev, o Vite proxia /api → backend. Em prod com domínios separados,
// defina VITE_API_URL no .env do front.
const apiBase = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.replace(/\/$/, '')}/api`
  : '/api';

// `withCredentials: true` faz o axios enviar e receber cookies (dt_session).
// Sem isso, login não persiste — o navegador joga fora o Set-Cookie.
const http = axios.create({ baseURL: apiBase, timeout: 15_000, withCredentials: true });

// Interceptor de 401 — dispara um CustomEvent que o AuthContext escuta pra
// limpar o user e cair na tela de login. Evita acoplar contexto aqui.
// O login flow em si pode receber 401 também (ex: /auth/me antes de logar),
// então não fazemos retry/redirect — só notificamos.
http.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }
    return Promise.reject(err);
  },
);

function withUnit(params: Record<string, unknown> | undefined, unitId: string | null) {
  return unitId ? { ...(params ?? {}), unitId } : params;
}

export const api = {
  // -------------------------------------------------------------------------
  // Auth — sessão Google + gestão de admins
  // -------------------------------------------------------------------------
  async me(): Promise<AuthUser | null> {
    try {
      const { data } = await http.get<{ user: AuthUser }>('/auth/me');
      return data.user;
    } catch (err) {
      const e = err as { response?: { status?: number } };
      if (e.response?.status === 401) return null;
      throw err;
    }
  },
  async login(email: string, password: string): Promise<AuthUser> {
    const { data } = await http.post<{ user: AuthUser }>('/auth/login', { email, password });
    return data.user;
  },
  async logout(): Promise<void> {
    await http.post('/auth/logout');
  },

  async listUsers(): Promise<AdminUser[]> {
    const { data } = await http.get<{ users: AdminUser[] }>('/users');
    return data.users;
  },
  async createUser(input: AdminUserInput & { password: string }): Promise<AdminUser> {
    const { data } = await http.post<{ user: AdminUser }>('/users', input);
    return data.user;
  },
  async updateUser(
    id: string,
    input: Partial<AdminUserInput> & { isActive?: boolean; password?: string },
  ): Promise<AdminUser> {
    const { data } = await http.patch<{ user: AdminUser }>(`/users/${id}`, input);
    return data.user;
  },
  async deleteUser(id: string): Promise<void> {
    await http.delete(`/users/${id}`);
  },

  // -------------------------------------------------------------------------
  // Traces
  // -------------------------------------------------------------------------
  async listTraces(unitId: string | null = null): Promise<TraceSummary[]> {
    const { data } = await http.get<{ traces: TraceSummary[] }>('/traces', {
      params: withUnit(undefined, unitId),
    });
    return data.traces;
  },

  async getTrace(id: string): Promise<TraceDetail> {
    const { data } = await http.get<{ trace: TraceDetail }>(`/traces/${id}`);
    return data.trace;
  },

  async getStats(unitId: string | null = null): Promise<Stats> {
    const { data } = await http.get<Stats>('/stats', { params: withUnit(undefined, unitId) });
    return data;
  },

  // -------------------------------------------------------------------------
  // SystemLogs — painel "Erros"
  // -------------------------------------------------------------------------
  async listSystemLogs(
    unitId: string | null = null,
    query: SystemLogQuery = {},
  ): Promise<SystemLogListResponse> {
    const { data } = await http.get<SystemLogListResponse>('/system-logs', {
      params: withUnit(query as Record<string, unknown>, unitId),
    });
    return data;
  },

  async listSystemLogModules(unitId: string | null = null): Promise<string[]> {
    const { data } = await http.get<{ modules: string[] }>('/system-logs/modules', {
      params: withUnit(undefined, unitId),
    });
    return data.modules;
  },

  // -------------------------------------------------------------------------
  // Captura de dados — LeadFieldRule (tools dinâmicas por custom field)
  // -------------------------------------------------------------------------
  async listLeadFieldRules(unitId: string): Promise<LeadFieldRule[]> {
    const { data } = await http.get<{ rules: LeadFieldRule[] }>(
      `/units/${unitId}/lead-field-rules`,
    );
    return data.rules;
  },
  async createLeadFieldRule(unitId: string, input: LeadFieldRuleInput): Promise<LeadFieldRule> {
    const { data } = await http.post<{ rule: LeadFieldRule }>(
      `/units/${unitId}/lead-field-rules`,
      input,
    );
    return data.rule;
  },
  async updateLeadFieldRule(
    unitId: string,
    ruleId: string,
    input: Partial<LeadFieldRuleInput>,
  ): Promise<LeadFieldRule> {
    const { data } = await http.patch<{ rule: LeadFieldRule }>(
      `/units/${unitId}/lead-field-rules/${ruleId}`,
      input,
    );
    return data.rule;
  },
  async deleteLeadFieldRule(unitId: string, ruleId: string): Promise<void> {
    await http.delete(`/units/${unitId}/lead-field-rules/${ruleId}`);
  },
  async kommoLeadCustomFields(unitId: string): Promise<KommoLeadCustomFieldsResponse> {
    const { data } = await http.get<KommoLeadCustomFieldsResponse>(
      `/units/${unitId}/kommo-lead-custom-fields`,
      { validateStatus: () => true },
    );
    return data;
  },

  // -------------------------------------------------------------------------
  // AgentConfig
  // -------------------------------------------------------------------------
  async getConfig(unitId: string | null = null): Promise<AgentConfigResponse> {
    const { data } = await http.get<AgentConfigResponse>('/config', {
      params: withUnit(undefined, unitId),
    });
    return data;
  },

  async saveConfig(input: AgentConfigInput): Promise<AgentConfig> {
    const { data } = await http.put<{ config: AgentConfig }>('/config', input);
    return data.config;
  },

  // -------------------------------------------------------------------------
  // Units
  // -------------------------------------------------------------------------
  async listUnits(): Promise<Unit[]> {
    const { data } = await http.get<{ units: Unit[] }>('/units');
    return data.units;
  },
  async getUnit(id: string): Promise<Unit> {
    const { data } = await http.get<{ unit: Unit }>(`/units/${id}`);
    return data.unit;
  },
  async createUnit(input: UnitInput): Promise<Unit> {
    const { data } = await http.post<{ unit: Unit }>('/units', input);
    return data.unit;
  },
  async updateUnit(id: string, input: Partial<UnitInput>): Promise<Unit> {
    const { data } = await http.patch<{ unit: Unit }>(`/units/${id}`, input);
    return data.unit;
  },
  async deleteUnit(id: string): Promise<void> {
    await http.delete(`/units/${id}`);
  },
  async cloneUnit(id: string): Promise<Unit> {
    const { data } = await http.post<{ unit: Unit }>(`/units/${id}/clone`);
    return data.unit;
  },
  async unitStats(id: string, days = 30): Promise<UnitStats> {
    const { data } = await http.get<UnitStats>(`/units/${id}/stats`, { params: { days } });
    return data;
  },
  async unitDashboard(id: string, days = 7): Promise<DashboardResponse> {
    const { data } = await http.get<DashboardResponse>(`/units/${id}/dashboard`, {
      params: { days },
      timeout: 30_000,
    });
    return data;
  },
  async leadsBucket(id: string, bucket: LeadsBucket, days = 7): Promise<LeadsBucketResponse> {
    const { data } = await http.get<LeadsBucketResponse>(`/units/${id}/leads-bucket`, {
      params: { bucket, days },
      timeout: 30_000,
    });
    return data;
  },

  // -------------------------------------------------------------------------
  // Integrations + Alerts (Central de Integrações)
  // -------------------------------------------------------------------------
  async getIntegrations(unitId: string, days = 30): Promise<IntegrationsResponse> {
    const { data } = await http.get<IntegrationsResponse>(`/units/${unitId}/integrations`, {
      params: { days },
      timeout: 30_000, // chama OpenAI Platform e Kommo, pode levar
    });
    return data;
  },
  async getAlerts(): Promise<GlobalAlert[]> {
    const { data } = await http.get<{ alerts: GlobalAlert[] }>('/alerts', {
      timeout: 30_000,
    });
    return data.alerts;
  },

  // -------------------------------------------------------------------------
  // LlmCalls
  // -------------------------------------------------------------------------
  async listLlmCalls(unitId: string | null = null, limit = 100): Promise<LlmCallSummary[]> {
    const params: Record<string, unknown> = { limit };
    if (unitId) params.unitId = unitId;
    const { data } = await http.get<{ calls: LlmCallSummary[] }>('/llm-calls', { params });
    return data.calls;
  },
  async getLlmCall(id: string): Promise<LlmCallDetail> {
    const { data } = await http.get<{ call: LlmCallDetail }>(`/llm-calls/${id}`);
    return data.call;
  },

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------
  async listConversations(unitId: string | null = null): Promise<ConversationSummary[]> {
    const { data } = await http.get<{ conversations: ConversationSummary[] }>('/conversations', {
      params: withUnit(undefined, unitId),
    });
    return data.conversations;
  },
  async getConversation(id: string): Promise<ConversationDetail> {
    const { data } = await http.get<{ conversation: ConversationDetail }>(`/conversations/${id}`);
    return data.conversation;
  },

  // -------------------------------------------------------------------------
  // Prompt performance / LLM-as-judge
  // -------------------------------------------------------------------------
  async getPromptPerformance(unitId: string, days = 90): Promise<PromptPerformanceResponse> {
    const { data } = await http.get<PromptPerformanceResponse>(
      `/units/${unitId}/prompt-performance`,
      { params: { days }, timeout: 30_000 },
    );
    return data;
  },
  async getConversationEvaluation(conversationId: string): Promise<ConversationEvaluationResponse> {
    const { data } = await http.get<ConversationEvaluationResponse>(
      `/conversations/${conversationId}/evaluation`,
    );
    return data;
  },
  async reEvaluateConversation(conversationId: string): Promise<void> {
    await http.post(`/conversations/${conversationId}/evaluate`, {}, { timeout: 60_000 });
  },

  // -------------------------------------------------------------------------
  // Kommo Explorer — listas ao vivo do CRM por Unit
  // -------------------------------------------------------------------------
  async kommoFields(unitId: string): Promise<KommoFieldsResponse> {
    const { data } = await http.get<KommoFieldsResponse>(
      `/units/${unitId}/kommo-fields`,
      { timeout: 30_000 },
    );
    return data;
  },
  async kommoSalesbots(unitId: string): Promise<KommoSalesbotsResponse> {
    const { data } = await http.get<KommoSalesbotsResponse>(
      `/units/${unitId}/kommo-salesbots`,
      { timeout: 30_000 },
    );
    return data;
  },
  async kommoTags(unitId: string): Promise<KommoTagsResponse> {
    const { data } = await http.get<KommoTagsResponse>(
      `/units/${unitId}/kommo-tags`,
      { timeout: 30_000 },
    );
    return data;
  },
  async kommoPipelines(unitId: string): Promise<KommoPipelinesResponse> {
    const { data } = await http.get<KommoPipelinesResponse>(
      `/units/${unitId}/kommo-pipelines`,
      { timeout: 30_000 },
    );
    return data;
  },
  async kommoValidate(unitId: string): Promise<KommoValidateResponse> {
    const { data } = await http.post<KommoValidateResponse>(
      `/units/${unitId}/kommo-validate`,
      {},
      { timeout: 30_000 },
    );
    return data;
  },

  async previewPrompt(unitId: string, overrides: Record<string, unknown>): Promise<{ prompt: string; chars: number }> {
    const { data } = await http.post<{ prompt: string; chars: number }>(
      `/units/${unitId}/preview-prompt`,
      overrides,
      { timeout: 10_000 },
    );
    return data;
  },

  async playgroundRun(
    unitId: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<{
    reply: string;
    actions: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
  }> {
    const { data } = await http.post<{
      reply: string;
      actions: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
    }>(`/units/${unitId}/playground/run`, { messages }, { timeout: 60_000 });
    return data;
  },

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------
  async listTemplates(unitId: string): Promise<MessageTemplate[]> {
    const { data } = await http.get<{ templates: MessageTemplate[] }>(`/units/${unitId}/templates`);
    return data.templates;
  },
  async createTemplate(unitId: string, input: { name: string; triggerKeywords: string[]; response: string }): Promise<MessageTemplate> {
    const { data } = await http.post<{ template: MessageTemplate }>(`/units/${unitId}/templates`, input);
    return data.template;
  },
  async updateTemplate(unitId: string, templateId: string, input: { name?: string; triggerKeywords?: string[]; response?: string }): Promise<MessageTemplate> {
    const { data } = await http.patch<{ template: MessageTemplate }>(`/units/${unitId}/templates/${templateId}`, input);
    return data.template;
  },
  async deleteTemplate(unitId: string, templateId: string): Promise<void> {
    await http.delete(`/units/${unitId}/templates/${templateId}`);
  },

  // -------------------------------------------------------------------------
  // Knowledge base (RAG)
  // -------------------------------------------------------------------------
  async listKnowledge(unitId: string): Promise<KnowledgeEntry[]> {
    const { data } = await http.get<{ entries: KnowledgeEntry[] }>(`/units/${unitId}/knowledge`);
    return data.entries;
  },
  async createKnowledge(unitId: string, input: { question: string; answer: string }): Promise<KnowledgeEntry> {
    const { data } = await http.post<{ entry: KnowledgeEntry }>(`/units/${unitId}/knowledge`, input, {
      timeout: 30_000,
    });
    return data.entry;
  },
  async updateKnowledge(unitId: string, entryId: string, input: { question?: string; answer?: string }): Promise<KnowledgeEntry> {
    const { data } = await http.patch<{ entry: KnowledgeEntry }>(
      `/units/${unitId}/knowledge/${entryId}`,
      input,
      { timeout: 30_000 },
    );
    return data.entry;
  },
  async deleteKnowledge(unitId: string, entryId: string): Promise<void> {
    await http.delete(`/units/${unitId}/knowledge/${entryId}`);
  },

  // -------------------------------------------------------------------------
  // Ações (regras "quando → faça")
  // -------------------------------------------------------------------------
  async listActions(unitId: string): Promise<UnitAction[]> {
    const { data } = await http.get<{ actions: UnitAction[] }>(`/units/${unitId}/actions`);
    return data.actions;
  },
  async createAction(unitId: string, input: UnitActionInput): Promise<UnitAction> {
    const { data } = await http.post<{ action: UnitAction }>(`/units/${unitId}/actions`, input);
    return data.action;
  },
  async updateAction(
    unitId: string,
    actionId: string,
    input: Partial<UnitActionInput>,
  ): Promise<UnitAction> {
    const { data } = await http.patch<{ action: UnitAction }>(
      `/units/${unitId}/actions/${actionId}`,
      input,
    );
    return data.action;
  },
  async deleteAction(unitId: string, actionId: string): Promise<void> {
    await http.delete(`/units/${unitId}/actions/${actionId}`);
  },

  // -------------------------------------------------------------------------
  // Flag de mensagens
  // -------------------------------------------------------------------------
  async flagMessage(messageId: string, flagged: boolean): Promise<void> {
    await http.patch(`/messages/${messageId}/flag`, { flagged });
  },
  async listFlaggedMessages(unitId: string): Promise<FlaggedMessage[]> {
    const { data } = await http.get<{ messages: FlaggedMessage[] }>(`/units/${unitId}/flagged-messages`);
    return data.messages;
  },

  // -------------------------------------------------------------------------
  // Debug do Admin Key da OpenAI
  // -------------------------------------------------------------------------
  async openaiDebug(unitId: string): Promise<OpenAIDebugResponse> {
    const { data } = await http.get<OpenAIDebugResponse>(
      `/units/${unitId}/openai-debug`,
      { timeout: 30_000 },
    );
    return data;
  },

  // -------------------------------------------------------------------------
  // Limpa todos os caches em memória do backend (config, unit, dedup) + o
  // localStorage do front. Pra usar quando algo "ficou grudado" e o usuário
  // quer forçar reload do estado.
  // -------------------------------------------------------------------------
  async clearCache(): Promise<{
    ok: boolean;
    cleared: { configCache: number; unitBySlugCache: number; unitByIdCache: number; dedupCache: number };
  }> {
    const { data } = await http.post<{
      ok: boolean;
      cleared: { configCache: number; unitBySlugCache: number; unitByIdCache: number; dedupCache: number };
    }>('/admin/clear-cache');
    return data;
  },
};
