import axios from 'axios';
import type {
  AgentConfig,
  AgentConfigInput,
  AgentConfigResponse,
  ConversationDetail,
  ConversationEvaluationResponse,
  ConversationSummary,
  GlobalAlert,
  IntegrationsResponse,
  KommoFieldsResponse,
  KommoPipelinesResponse,
  KommoSalesbotsResponse,
  KommoValidateResponse,
  LlmCallDetail,
  LlmCallSummary,
  OpenAIDebugResponse,
  PromptPerformanceResponse,
  Stats,
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

const http = axios.create({ baseURL: apiBase, timeout: 15_000 });

function withUnit(params: Record<string, unknown> | undefined, unitId: string | null) {
  return unitId ? { ...(params ?? {}), unitId } : params;
}

export const api = {
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
  async unitStats(id: string, days = 30): Promise<UnitStats> {
    const { data } = await http.get<UnitStats>(`/units/${id}/stats`, { params: { days } });
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
};
