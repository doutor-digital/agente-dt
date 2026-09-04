import axios from 'axios';
import type {
  AdminUser,
  AdminUserInput,
  AgentConfig,
  AgentConfigInput,
  AgentConfigResponse,
  AuthUser,
  ConversationDetail,
  AggregateDashboardResponse,
  ConversationEvaluationResponse,
  ConversationSummary,
  DashboardResponse,
  DeliveryMonitor,
  GlobalAlert,
  IntegrationsResponse,
  FlaggedMessage,
  KnowledgeEntry,
  ChangeLogEntry,
  LessonEntry,
  StrategyLabResult,
  KnowledgeLinkEntry,
  KommoFieldsResponse,
  KommoLossReasonsResponse,
  KommoPipelinesResponse,
  KommoSalesbotsResponse,
  KommoTagsResponse,
  KommoUsersResponse,
  KommoValidateResponse,
  MetaValidateInput,
  MetaValidateResponse,
  WidgetStatusResponse,
  LeadsBucket,
  LeadsBucketResponse,
  MessageTemplate,
  LlmCallDetail,
  UnitAction,
  UnitActionInput,
  LlmCallSummary,
  OpenAIDebugResponse,
  KommoLeadCustomFieldsResponse,
  CaptureCoverage,
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
  WhatsappCostsResponse,
  WhatsappTemplatesResponse,
  WhatsappSyncResult,
  IgCommentStatus,
  InstagramComment,
  InstagramCommentsResponse,
  SpineStatus,
  SpineSchedulesResponse,
  AgendaBlock,
  SpineLeadLinksResponse,
  SpineLeadPreview,
  SpineProntidao,
  SpinePendentesResponse,
  SpinePatientPreview,
  FollowUpRulesResponse,
  FollowUpStep,
  SaudeIa,
  ResumoResultados,
  Funcionamento,
} from '../types/api';

const apiBase = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.replace(/\/$/, '')}/api`
  : '/api';

export const apiOrigin = import.meta.env.VITE_API_URL
  ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '')
  : window.location.origin;

export function webhookUrl(
  slug: string,
  channel: 'instagram' | 'facebook' | 'meta' | 'kommo',
): string {
  return `${apiOrigin}/api/webhooks/${slug}/${channel}`;
}

const http = axios.create({ baseURL: apiBase, timeout: 15_000, withCredentials: true });

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

export type PlaygroundAction = {
  tool: string;
  args: Record<string, unknown>;
  result: string;
};

export type PlaygroundTokens = { prompt: number; completion: number; total: number };

export type PlaygroundTimelineEvent =
  | { kind: 'user_message'; ts: number; content: string }
  | {
      kind: 'thinking';
      ts: number;
      durationMs: number;
      model: string;
      iteration: number;
      tokens?: PlaygroundTokens;
      costUsd?: number;
    }
  | {
      kind: 'tool_call';
      ts: number;
      tool: string;
      args: Record<string, unknown>;
      result: string;
    }
  | { kind: 'assistant_message'; ts: number; content: string };

export type PlaygroundRunResult = {
  reply: string;
  actions: PlaygroundAction[];
  timeline: PlaygroundTimelineEvent[];
  meta: {
    model: string;
    iterations: number;
    totalLatencyMs: number;
    tokens: PlaygroundTokens | null;
    costUsd: number | null;
  };
};

export const api = {
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

  async listLeadFieldRules(unitId: string): Promise<LeadFieldRule[]> {
    const { data } = await http.get<{ rules: LeadFieldRule[] }>(
      `/units/${unitId}/lead-field-rules`,
    );
    return data.rules;
  },
  async resultados(unitId: string, days = 60): Promise<ResumoResultados> {
    const { data } = await http.get<ResumoResultados>(`/units/${unitId}/resultados`, { params: { days } });
    return data;
  },
  async recalcularResultados(unitId: string, days = 60): Promise<{ ok: boolean; calculadas: number; erros: number; resumo: ResumoResultados }> {
    const { data } = await http.post(`/units/${unitId}/resultados/recalcular`, null, { params: { days, limit: 2000 } });
    return data;
  },
  async funcionamento(unitId: string, days = 7): Promise<Funcionamento> {
    const { data } = await http.get<Funcionamento>(`/units/${unitId}/funcionamento`, { params: { days } });
    return data;
  },
  async saudeIa(unitId: string): Promise<SaudeIa> {
    const { data } = await http.get<SaudeIa>(`/units/${unitId}/saude-ia`);
    return data;
  },
  async spineStatus(unitId: string): Promise<SpineStatus> {
    const { data } = await http.get<SpineStatus>(`/units/${unitId}/spine/status`);
    return data;
  },
  async updateReminder(
    unitId: string,
    body: { enabled?: boolean; salesbotId?: number | null; hourLocal?: number },
  ): Promise<{ ok: boolean; reminder?: SpineStatus['reminder'] }> {
    const { data } = await http.patch(`/units/${unitId}/spine/reminder`, body);
    return data;
  },
  async spineSchedules(
    unitId: string,
    params: { initialDate: string; endDate: string },
  ): Promise<SpineSchedulesResponse> {
    const { data } = await http.get<SpineSchedulesResponse>(
      `/units/${unitId}/spine/schedules`,
      { params },
    );
    return data;
  },
  async spinePing(unitId: string): Promise<{ ok: boolean; error?: string }> {
    const { data } = await http.post<{ ok: boolean; error?: string }>(
      `/units/${unitId}/spine/ping`,
    );
    return data;
  },
  async spineLeadPreview(unitId: string, kommoLeadId: number): Promise<SpineLeadPreview> {
    const { data } = await http.post<SpineLeadPreview>(
      `/units/${unitId}/spine/lead-preview`,
      { kommoLeadId },
    );
    return data;
  },
  async spineCancelSchedule(
    unitId: string,
    kommoLeadId: number,
  ): Promise<{ ok: boolean; motivo?: string; quando?: string | null }> {
    const { data } = await http.post<{ ok: boolean; motivo?: string; quando?: string | null }>(
      `/units/${unitId}/spine/cancel-schedule`,
      { kommoLeadId },
      { timeout: 30_000, validateStatus: (s) => s === 200 || s === 422 || s === 502 },
    );
    return data;
  },
  async spinePatientPreview(unitId: string, kommoLeadId: number): Promise<SpinePatientPreview> {
    const { data } = await http.post<SpinePatientPreview>(
      `/units/${unitId}/spine/patient-preview`,
      { kommoLeadId },
      { timeout: 30_000 },
    );
    return data;
  },
  async spineSyncPatient(
    unitId: string,
    kommoLeadId: number,
  ): Promise<{ ok: boolean; motivo?: string; spineIdClient?: number }> {
    const { data } = await http.post<{ ok: boolean; motivo?: string; spineIdClient?: number }>(
      `/units/${unitId}/spine/sync-patient`,
      { kommoLeadId },
      { timeout: 30_000, validateStatus: (s) => s === 200 || s === 422 },
    );
    return data;
  },
  async followUpRules(unitId: string): Promise<FollowUpRulesResponse> {
    const { data } = await http.get<FollowUpRulesResponse>(`/units/${unitId}/follow-up/rules`);
    return data;
  },
  async saveFollowUpRule(
    unitId: string,
    regra: {
      statusId: number;
      lossReasonId: number | null;
      lossReasonName?: string | null;
      enabled?: boolean;
      notes?: string | null;
      steps?: FollowUpStep[];
    },
  ): Promise<void> {
    await http.post(`/units/${unitId}/follow-up/rules`, regra, { timeout: 20_000 });
  },
  async toggleFollowUp(unitId: string, enabled: boolean): Promise<void> {
    await http.post(`/units/${unitId}/follow-up/toggle`, { enabled }, { timeout: 20_000 });
  },

  async spinePendentes(unitId: string, dias = 7): Promise<SpinePendentesResponse> {
    const { data } = await http.get<SpinePendentesResponse>(
      `/units/${unitId}/spine/pendentes`,
      { params: { dias }, timeout: 30_000 },
    );
    return data;
  },
  async spineProntidao(unitId: string): Promise<SpineProntidao> {
    const { data } = await http.get<SpineProntidao>(`/units/${unitId}/spine/prontidao`);
    return data;
  },
  async spineLeadLinks(unitId: string): Promise<SpineLeadLinksResponse> {
    const { data } = await http.get<SpineLeadLinksResponse>(`/units/${unitId}/spine/lead-links`);
    return data;
  },
  async spineSyncLead(unitId: string, kommoLeadId: number): Promise<{ ok: boolean; motivo?: string; spineIdLead?: number }> {
    const { data } = await http.post<{ ok: boolean; motivo?: string; spineIdLead?: number }>(
      `/units/${unitId}/spine/sync-lead`,
      { kommoLeadId },
    );
    return data;
  },
  async blockAgenda(
    unitId: string,
    body: { dayLocal: string; startTime: string; endTime: string; reason?: string | null },
  ): Promise<AgendaBlock> {
    const { data } = await http.post<{ block: AgendaBlock }>(
      `/units/${unitId}/agenda/blocks`,
      body,
    );
    return data.block;
  },
  async blockAgendaBulk(
    unitId: string,
    body: {
      fromDay: string;
      toDay: string;
      startTime?: string;
      endTime?: string;
      weekdays?: number[];
      reason?: string | null;
    },
  ): Promise<{ dias: number; criados: number }> {
    const { data } = await http.post<{ dias: number; criados: number }>(
      `/units/${unitId}/agenda/blocks/bulk`,
      body,
    );
    return data;
  },
  async unblockAgendaBulk(
    unitId: string,
    params: { fromDay: string; toDay: string },
  ): Promise<{ removidos: number }> {
    const { data } = await http.delete<{ removidos: number }>(
      `/units/${unitId}/agenda/blocks/bulk`,
      { params },
    );
    return data;
  },
  async listAgendaBlocks(
    unitId: string,
    params: { fromDay: string; toDay: string },
  ): Promise<AgendaBlock[]> {
    const { data } = await http.get<{ blocks: AgendaBlock[] }>(
      `/units/${unitId}/agenda/blocks`,
      { params },
    );
    return data.blocks;
  },
  async unblockAgenda(unitId: string, blockId: string): Promise<void> {
    await http.delete(`/units/${unitId}/agenda/blocks/${blockId}`);
  },
  async emergencyPause(unitId: string, reason?: string): Promise<void> {
    await http.post('/system/emergency-pause', { unitId, reason });
  },
  async resumeAi(unitId: string): Promise<void> {
    await http.post('/system/resume', { unitId });
  },

  async instagramComments(
    unitId: string,
    params: { status?: IgCommentStatus; platform?: 'instagram' | 'facebook'; limit?: number } = {},
  ): Promise<InstagramCommentsResponse> {
    const { data } = await http.get<InstagramCommentsResponse>(
      `/units/${unitId}/instagram/comments`,
      { params },
    );
    return data;
  },
  async approveInstagramComment(
    unitId: string,
    rowId: string,
    body: { publicReply?: string | null; privateReply?: string | null } = {},
  ): Promise<InstagramComment> {
    const { data } = await http.post<{ comment: InstagramComment }>(
      `/units/${unitId}/instagram/comments/${rowId}/approve`,
      body,
    );
    return data.comment;
  },
  async rejectInstagramComment(unitId: string, rowId: string): Promise<InstagramComment> {
    const { data } = await http.post<{ comment: InstagramComment }>(
      `/units/${unitId}/instagram/comments/${rowId}/reject`,
    );
    return data.comment;
  },
  async captureCoverage(unitId: string, days = 30): Promise<CaptureCoverage> {
    const { data } = await http.get<CaptureCoverage>(
      `/units/${unitId}/lead-field-rules/coverage`,
      { params: { days } },
    );
    return data;
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

  async getFlattenedPrompt(unitId: string): Promise<string> {
    const { data } = await http.get<{ prompt: string }>('/config/flatten', {
      params: { unitId },
    });
    return data.prompt;
  },

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
    try {
      const { data } = await http.patch<{ unit: Unit }>(`/units/${id}`, input, { timeout: 20_000 });
      return data.unit;
    } catch (err) {
      const semResposta = axios.isAxiosError(err) && !err.response;
      if (!semResposta) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      const { data } = await http.patch<{ unit: Unit }>(`/units/${id}`, input, { timeout: 45_000 });
      return data.unit;
    }
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
  async aggregateDashboard(days = 7, category?: string): Promise<AggregateDashboardResponse> {
    const { data } = await http.get<AggregateDashboardResponse>(`/dashboard`, {
      params: { days, ...(category ? { category } : {}) },
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

  async getIntegrations(unitId: string, days = 30): Promise<IntegrationsResponse> {
    const { data } = await http.get<IntegrationsResponse>(`/units/${unitId}/integrations`, {
      params: { days },
      timeout: 30_000,
    });
    return data;
  },
  async getAlerts(): Promise<GlobalAlert[]> {
    const { data } = await http.get<{ alerts: GlobalAlert[] }>('/alerts', {
      timeout: 30_000,
    });
    return data.alerts;
  },
  async getDeliveryMonitor(): Promise<DeliveryMonitor> {
    const { data } = await http.get<DeliveryMonitor>('/delivery-monitor', {
      timeout: 30_000,
    });
    return data;
  },

  async getWhatsappCosts(
    unitId: string,
    range: { from?: string; to?: string } = {},
  ): Promise<WhatsappCostsResponse> {
    const { data } = await http.get<WhatsappCostsResponse>(
      `/units/${unitId}/whatsapp-costs`,
      { params: range },
    );
    return data;
  },
  async getWhatsappTemplates(
    unitId: string,
    range: { from?: string; to?: string } = {},
  ): Promise<WhatsappTemplatesResponse> {
    const { data } = await http.get<WhatsappTemplatesResponse>(
      `/units/${unitId}/whatsapp-templates`,
      { params: range },
    );
    return data;
  },
  async syncWhatsappCosts(
    unitId: string,
    body: { lookbackDays?: number } = {},
  ): Promise<WhatsappSyncResult> {
    const { data } = await http.post<WhatsappSyncResult>(
      `/units/${unitId}/whatsapp-costs/sync`,
      body,
      { timeout: 60_000 },
    );
    return data;
  },

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
  async kommoUsers(unitId: string): Promise<KommoUsersResponse> {
    const { data } = await http.get<KommoUsersResponse>(
      `/units/${unitId}/kommo-users`,
      { timeout: 30_000 },
    );
    return data;
  },
  async kommoLossReasons(unitId: string): Promise<KommoLossReasonsResponse> {
    const { data } = await http.get<KommoLossReasonsResponse>(
      `/units/${unitId}/kommo-loss-reasons`,
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
  async metaValidate(
    unitId: string,
    override: MetaValidateInput = {},
  ): Promise<MetaValidateResponse> {
    const { data } = await http.post<MetaValidateResponse>(
      `/units/${unitId}/meta-validate`,
      override,
      { timeout: 30_000 },
    );
    return data;
  },

  async widgetStatus(unitId: string): Promise<WidgetStatusResponse> {
    const { data } = await http.get<WidgetStatusResponse>(
      `/units/${unitId}/widget-status`,
      { timeout: 15_000 },
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
  ): Promise<PlaygroundRunResult> {
    const { data } = await http.post<PlaygroundRunResult>(
      `/units/${unitId}/playground/run`,
      { messages },
      { timeout: 60_000 },
    );
    return data;
  },

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

  async listKnowledge(unitId: string): Promise<KnowledgeEntry[]> {
    const { data } = await http.get<{ entries: KnowledgeEntry[] }>(`/units/${unitId}/knowledge`);
    return data.entries;
  },
  async getChangeLog(unitId: string): Promise<ChangeLogEntry[]> {
    const { data } = await http.get<{ entries: ChangeLogEntry[] }>(`/units/${unitId}/changelog`);
    return data.entries;
  },
  async getLessons(unitId: string): Promise<LessonEntry[]> {
    const { data } = await http.get<{ lessons: LessonEntry[] }>(`/units/${unitId}/lessons`);
    return data.lessons;
  },
  async createLesson(unitId: string, content: string): Promise<LessonEntry> {
    const { data } = await http.post<{ lesson: LessonEntry }>(`/units/${unitId}/lessons`, { content });
    return data.lesson;
  },
  async updateLesson(
    unitId: string,
    id: string,
    patch: { content?: string; enabled?: boolean },
  ): Promise<void> {
    await http.patch(`/units/${unitId}/lessons/${id}`, patch);
  },
  async deleteLesson(unitId: string, id: string): Promise<void> {
    await http.delete(`/units/${unitId}/lessons/${id}`);
  },
  async runStrategyLab(
    unitId: string,
    conversationId: string,
    ownerNote?: string,
  ): Promise<StrategyLabResult> {
    const { data } = await http.post<StrategyLabResult>(
      `/units/${unitId}/strategy-lab`,
      { conversationId, ownerNote: ownerNote ?? null },
      { timeout: 60_000 },
    );
    return data;
  },
  async escolherEstrategia(unitId: string, runId: string, texto: string): Promise<void> {
    await http.post(`/units/${unitId}/strategy-lab/${runId}/escolher`, { texto });
  },
  async listKnowledgeLinks(unitId: string): Promise<KnowledgeLinkEntry[]> {
    const { data } = await http.get<{ links: KnowledgeLinkEntry[] }>(`/units/${unitId}/knowledge-links`);
    return data.links;
  },
  async addKnowledgeLink(unitId: string, url: string): Promise<KnowledgeLinkEntry | null> {
    const { data } = await http.post<{ link: KnowledgeLinkEntry | null }>(
      `/units/${unitId}/knowledge-links`,
      { url },
      { timeout: 90_000 },
    );
    return data.link;
  },
  async reprocessKnowledgeLink(unitId: string, linkId: string): Promise<void> {
    await http.post(`/units/${unitId}/knowledge-links/${linkId}/processar`, {}, { timeout: 90_000 });
  },
  async deleteKnowledgeLink(unitId: string, linkId: string): Promise<void> {
    await http.delete(`/units/${unitId}/knowledge-links/${linkId}`);
  },
  async reflectLessons(unitId: string): Promise<{ proposed: number; analisadas: number }> {
    const { data } = await http.post<{ proposed: number; analisadas: number }>(
      `/units/${unitId}/lessons/reflect`,
      {},
    );
    return data;
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

  async listGlobalActions(): Promise<UnitAction[]> {
    const { data } = await http.get<{ actions: UnitAction[] }>(`/global-actions`);
    return data.actions;
  },
  async createGlobalAction(input: UnitActionInput): Promise<UnitAction> {
    const { data } = await http.post<{ action: UnitAction }>(`/global-actions`, input);
    return data.action;
  },
  async updateGlobalAction(
    actionId: string,
    input: Partial<UnitActionInput>,
  ): Promise<UnitAction> {
    const { data } = await http.patch<{ action: UnitAction }>(
      `/global-actions/${actionId}`,
      input,
    );
    return data.action;
  },
  async deleteGlobalAction(actionId: string): Promise<void> {
    await http.delete(`/global-actions/${actionId}`);
  },

  async downloadReport(
    type: 'conversations' | 'llm-cost' | 'actions' | 'errors' | 'whatsapp-cost',
    format: 'csv' | 'pdf',
    filters: { unitId?: string | null; from?: string; to?: string } = {},
  ): Promise<void> {
    const params = new URLSearchParams({ format });
    if (filters.unitId) params.set('unitId', filters.unitId);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);

    const res = await http.get(`/reports/${type}?${params.toString()}`, {
      responseType: 'blob',
      timeout: 60_000,
    });
    const cd = res.headers['content-disposition'] as string | undefined;
    const match = cd?.match(/filename="?([^";]+)"?/);
    const filename = match?.[1] ?? `relatorio-${type}.${format}`;

    const blob = new Blob([res.data as BlobPart], {
      type: format === 'pdf' ? 'application/pdf' : 'text/csv;charset=utf-8',
    });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  },

  async flagMessage(messageId: string, flagged: boolean): Promise<void> {
    await http.patch(`/messages/${messageId}/flag`, { flagged });
  },
  async listFlaggedMessages(unitId: string): Promise<FlaggedMessage[]> {
    const { data } = await http.get<{ messages: FlaggedMessage[] }>(`/units/${unitId}/flagged-messages`);
    return data.messages;
  },

  async openaiDebug(unitId: string): Promise<OpenAIDebugResponse> {
    const { data } = await http.get<OpenAIDebugResponse>(
      `/units/${unitId}/openai-debug`,
      { timeout: 30_000 },
    );
    return data;
  },

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
