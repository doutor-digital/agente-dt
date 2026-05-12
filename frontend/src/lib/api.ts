import axios from 'axios';
import type {
  AgentConfig,
  AgentConfigInput,
  AgentConfigResponse,
  Stats,
  TraceDetail,
  TraceSummary,
} from '../types/api';

// O Vite dev server proxia /api → backend, então usamos path relativo.
const http = axios.create({ baseURL: '/api', timeout: 10_000 });

export const api = {
  async listTraces(): Promise<TraceSummary[]> {
    const { data } = await http.get<{ traces: TraceSummary[] }>('/traces');
    return data.traces;
  },

  async getTrace(id: string): Promise<TraceDetail> {
    const { data } = await http.get<{ trace: TraceDetail }>(`/traces/${id}`);
    return data.trace;
  },

  async getStats(): Promise<Stats> {
    const { data } = await http.get<Stats>('/stats');
    return data;
  },

  async getConfig(): Promise<AgentConfigResponse> {
    const { data } = await http.get<AgentConfigResponse>('/config');
    return data;
  },

  async saveConfig(input: AgentConfigInput): Promise<AgentConfig> {
    const { data } = await http.put<{ config: AgentConfig }>('/config', input);
    return data.config;
  },
};
