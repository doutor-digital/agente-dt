// ============================================================================
// kommo.service.ts — Cliente HTTP do Kommo CRM.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Esta camada faz UMA coisa: traduzir chamadas tipadas (addTag, moveStage,
// getLead) em requisições HTTP para a API v4 do Kommo. Ela é DELIBERADAMENTE
// burra:
//
//  - Não conhece LangGraph.
//  - Não conhece Prisma.
//  - Não conhece logger de aplicação além do necessário para diagnóstico.
//  - Não decide o que fazer com erros de negócio — propaga.
//
// Por que essa pureza importa?
// Porque amanhã o Kommo pode mudar de versão de API, ou podemos trocar
// `axios` por `undici`, ou precisar mockar tudo em testes. Nada disso pode
// vazar para a camada de agente. A interface pública aqui é o contrato.
//
// Concorrência: usamos UMA instância de axios com timeout e baseURL. Os
// interceptors centralizam retry simples (idempotente apenas para GET) e
// log de latência por chamada.
// ============================================================================

import axios, { AxiosError, type AxiosInstance } from 'axios';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Tipos públicos — o que outras camadas enxergam.
// ---------------------------------------------------------------------------

export interface KommoLead {
  id: number;
  name: string;
  status_id: number;
  pipeline_id: number;
  price?: number;
  _embedded?: {
    tags?: Array<{ id: number; name: string }>;
    contacts?: Array<{ id: number }>;
  };
}

export interface AddTagParams {
  leadId: number;
  tag: string;
}

export interface MoveStageParams {
  leadId: number;
  /** ID do status (etapa) no pipeline destino. */
  statusId: number;
  /** Opcional: ID do pipeline destino (caso queira mover entre funis). */
  pipelineId?: number;
}

// ---------------------------------------------------------------------------
// Erro de domínio — não vazamos AxiosError para cima.
// ---------------------------------------------------------------------------

export class KommoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly responseBody: unknown,
  ) {
    super(message);
    this.name = 'KommoApiError';
  }
}

// ---------------------------------------------------------------------------
// Cliente axios pré-configurado.
//
// baseURL: https://{subdomain}.kommo.com/api/v4
// Auth: Bearer token (Long-Lived Access Token gerado no painel do Kommo).
// timeout: 15s — webhooks do Kommo expiram em 30s, então temos margem.
// ---------------------------------------------------------------------------
const http: AxiosInstance = axios.create({
  baseURL: `https://${env.KOMMO_SUBDOMAIN}.kommo.com/api/v4`,
  timeout: 15_000,
  headers: {
    Authorization: `Bearer ${env.KOMMO_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

http.interceptors.request.use((config) => {
  (config as { metadata?: { start: number } }).metadata = { start: performance.now() };
  return config;
});

http.interceptors.response.use(
  (response) => {
    const meta = (response.config as { metadata?: { start: number } }).metadata;
    if (meta) {
      logger.debug(
        { method: response.config.method, url: response.config.url, ms: Math.round(performance.now() - meta.start) },
        'kommo http ok',
      );
    }
    return response;
  },
  (error: AxiosError) => {
    logger.warn(
      {
        method: error.config?.method,
        url: error.config?.url,
        status: error.response?.status,
        body: error.response?.data,
      },
      'kommo http error',
    );
    return Promise.reject(error);
  },
);

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function wrapAxiosError(err: unknown, context: string): never {
  if (axios.isAxiosError(err)) {
    throw new KommoApiError(
      `${context}: ${err.message}`,
      err.response?.status,
      err.response?.data,
    );
  }
  throw err;
}

// ---------------------------------------------------------------------------
// API pública do service.
// ---------------------------------------------------------------------------

export const KommoService = {
  /**
   * Recupera um lead com tags e contatos embedados.
   * Útil para o agente conhecer o estado atual antes de decidir.
   */
  async getLead(leadId: number): Promise<KommoLead> {
    try {
      const { data } = await http.get<KommoLead>(`/leads/${leadId}`, {
        params: { with: 'contacts' },
      });
      return data;
    } catch (err) {
      wrapAxiosError(err, `getLead(${leadId})`);
    }
  },

  /**
   * Adiciona uma tag a um lead.
   *
   * A API do Kommo trata tags como recurso embedado: a única forma de
   * "adicionar" é PATCH no lead com `_embedded.tags` contendo a nova tag.
   * Sem ID conhecido a Kommo cria/reusa pelo nome (idempotente do lado deles).
   */
  async addTag({ leadId, tag }: AddTagParams): Promise<void> {
    try {
      await http.patch(`/leads/${leadId}`, {
        _embedded: {
          tags: [{ name: tag }],
        },
      });
    } catch (err) {
      wrapAxiosError(err, `addTag(${leadId}, ${tag})`);
    }
  },

  /**
   * Move um lead para outra etapa do pipeline.
   * `status_id` é obrigatório; `pipeline_id` é opcional (mesmo funil por padrão).
   */
  async moveStage({ leadId, statusId, pipelineId }: MoveStageParams): Promise<void> {
    try {
      await http.patch(`/leads/${leadId}`, {
        status_id: statusId,
        ...(pipelineId ? { pipeline_id: pipelineId } : {}),
      });
    } catch (err) {
      wrapAxiosError(err, `moveStage(${leadId}, status=${statusId})`);
    }
  },
};

export type KommoServiceType = typeof KommoService;
