import axios from 'axios';
import type {
  AgentConfig,
  AgentConfigInput,
  AgentConfigResponse,
  Stats,
  TraceDetail,
  TraceSummary,
} from '../types/api';

// Em dev, o Vite proxia /api → backend (mesma origem). Em produção com front
// e back em domínios separados (ex: app.dt.com.br × api.dt.com.br), defina
// VITE_API_URL no .env do front. Sem VITE_API_URL caímos no path relativo
// — funciona quando back e front compartilham o domínio.
const apiBase = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.replace(/\/$/, '')}/api`
  : '/api';

const http = axios.create({ baseURL: apiBase, timeout: 10_000 });

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
