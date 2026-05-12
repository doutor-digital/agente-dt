// ============================================================================
// kommo.service.ts — Cliente HTTP do Kommo CRM (multi-tenant).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Antes era um SINGLETON com credenciais do .env. Agora cada Unit tem seu
// próprio Kommo (subdomínio + token) — então criamos UMA INSTÂNCIA por
// Unit. A API pública continua igual: addTag, moveStage, getLead, ...
//
// Mantemos `KommoService` como singleton fallback (lê .env) para retrocompat
// com webhooks legados sem slug. O caminho novo é `createKommoService(unit)`.
//
// CAMADA DELIBERADAMENTE BURRA
// ----------------------------
//  - Não conhece LangGraph.
//  - Não conhece Prisma.
//  - Não decide o que fazer com erros de negócio — propaga (KommoApiError).
// Isso permite trocar Kommo por HubSpot amanhã reescrevendo só este arquivo.
// ============================================================================

import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { Unit } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Tipos públicos
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
  statusId: number;
  pipelineId?: number;
}

export interface SendChatReplyParams {
  leadId: number;
  text: string;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
}

export type SendChatReplyVia = 'salesbot' | 'chat_message' | 'lead_note';

export interface SendChatReplyResult {
  via: SendChatReplyVia;
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Erro de domínio — nunca vazamos AxiosError pra cima.
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
// Config interna do cliente — derivada de uma Unit ou do env legado.
// ---------------------------------------------------------------------------

interface KommoCreds {
  subdomain: string;
  accessToken: string;
  salesbotId: number | null;
  replyFieldId: number | null;
}

function credsFromUnit(unit: Pick<Unit, 'kommoSubdomain' | 'kommoAccessToken' | 'kommoSalesbotId' | 'kommoReplyFieldId'>): KommoCreds {
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    throw new Error('Unit sem credenciais Kommo configuradas');
  }
  return {
    subdomain: unit.kommoSubdomain,
    accessToken: unit.kommoAccessToken,
    salesbotId: unit.kommoSalesbotId,
    replyFieldId: unit.kommoReplyFieldId,
  };
}

function credsFromEnv(): KommoCreds {
  return {
    subdomain: env.KOMMO_SUBDOMAIN,
    accessToken: env.KOMMO_ACCESS_TOKEN,
    salesbotId: env.KOMMO_SALESBOT_ID ?? null,
    replyFieldId: env.KOMMO_REPLY_FIELD_ID ?? null,
  };
}

function buildHttp(creds: KommoCreds): AxiosInstance {
  const http = axios.create({
    baseURL: `https://${creds.subdomain}.kommo.com/api/v4`,
    timeout: 15_000,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
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
  return http;
}

function wrapAxiosError(err: unknown, context: string): never {
  if (axios.isAxiosError(err)) {
    throw new KommoApiError(`${context}: ${err.message}`, err.response?.status, err.response?.data);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Classe instanciável — uma por Unit.
// Métodos espelham o que era o objeto KommoService original.
// ---------------------------------------------------------------------------

export class KommoClient {
  constructor(private readonly creds: KommoCreds, private readonly http: AxiosInstance) {}

  get subdomain(): string {
    return this.creds.subdomain;
  }

  async getLead(leadId: number): Promise<KommoLead> {
    try {
      const { data } = await this.http.get<KommoLead>(`/leads/${leadId}`, {
        params: { with: 'contacts' },
      });
      return data;
    } catch (err) {
      wrapAxiosError(err, `getLead(${leadId})`);
    }
  }

  async listLeadCustomFields(): Promise<unknown> {
    try {
      const { data } = await this.http.get('/leads/custom_fields', { params: { limit: 250 } });
      return data;
    } catch (err) {
      wrapAxiosError(err, 'listLeadCustomFields');
    }
  }

  async listSalesbots(): Promise<unknown> {
    try {
      const { data } = await this.http.get('/salesbot');
      return data;
    } catch (err) {
      wrapAxiosError(err, 'listSalesbots');
    }
  }

  async addTag({ leadId, tag }: AddTagParams): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, { _embedded: { tags: [{ name: tag }] } });
    } catch (err) {
      wrapAxiosError(err, `addTag(${leadId}, ${tag})`);
    }
  }

  async moveStage({ leadId, statusId, pipelineId }: MoveStageParams): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, {
        status_id: statusId,
        ...(pipelineId ? { pipeline_id: pipelineId } : {}),
      });
    } catch (err) {
      wrapAxiosError(err, `moveStage(${leadId}, status=${statusId})`);
    }
  }

  async runSalesbot({
    leadId,
    salesbotId,
    replyFieldId,
    text,
  }: {
    leadId: number;
    salesbotId: number;
    replyFieldId: number;
    text: string;
  }): Promise<unknown> {
    try {
      await this.http.patch(`/leads/${leadId}`, {
        custom_fields_values: [{ field_id: replyFieldId, values: [{ value: text }] }],
      });
    } catch (err) {
      wrapAxiosError(err, `runSalesbot:setField(${leadId}, field=${replyFieldId})`);
    }

    try {
      const { data } = await this.http.post(`/salesbot/${salesbotId}/run`, [
        { bot_id: salesbotId, entity_type: 2, entity_id: leadId },
      ]);
      return data;
    } catch (err) {
      wrapAxiosError(err, `runSalesbot:run(${leadId}, bot=${salesbotId})`);
    }
  }

  /**
   * Envia a resposta da IA de volta ao paciente. Estratégia em camadas:
   *  1. Salesbot (se Unit tem salesbotId + replyFieldId).
   *  2. POST /chats/{chatId}/messages (raro funcionar com WABA nativo).
   *  3. Cria nota comum no lead (sempre funciona, mas só visível ao operador).
   */
  async sendChatReply({
    leadId,
    text,
    chatId,
    talkId,
    contactId,
  }: SendChatReplyParams): Promise<SendChatReplyResult> {
    if (this.creds.salesbotId && this.creds.replyFieldId) {
      try {
        const data = await this.runSalesbot({
          leadId,
          salesbotId: this.creds.salesbotId,
          replyFieldId: this.creds.replyFieldId,
          text,
        });
        logger.info({ leadId, salesbotId: this.creds.salesbotId }, 'kommo salesbot disparado');
        return { via: 'salesbot', detail: data };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        logger.warn({ err, leadId, status }, 'salesbot falhou, tentando outros caminhos');
      }
    }

    if (chatId) {
      try {
        const { data } = await this.http.post(`/chats/${chatId}/messages`, {
          text,
          ...(talkId ? { talk_id: talkId } : {}),
          ...(contactId ? { contact_id: contactId } : {}),
        });
        logger.info({ leadId, chatId, talkId }, 'kommo chat message enviada');
        return { via: 'chat_message', detail: data };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        logger.debug({ err, leadId, chatId, status }, 'chats/{id}/messages falhou, caindo pra nota');
      }
    }

    try {
      const { data } = await this.http.post(`/leads/${leadId}/notes`, [
        { note_type: 'common', params: { text: `🤖 IA: ${text}` } },
      ]);
      logger.info({ leadId }, 'kommo nota criada com resposta da IA');
      return { via: 'lead_note', detail: data };
    } catch (err) {
      wrapAxiosError(err, `sendChatReply(${leadId})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: cliente por Unit.
// ---------------------------------------------------------------------------

export function createKommoClient(
  unit: Pick<Unit, 'kommoSubdomain' | 'kommoAccessToken' | 'kommoSalesbotId' | 'kommoReplyFieldId'>,
): KommoClient {
  const creds = credsFromUnit(unit);
  return new KommoClient(creds, buildHttp(creds));
}

// ---------------------------------------------------------------------------
// SINGLETON LEGADO — usa env, mantido pra retrocompat dos endpoints
// `/admin/kommo-fields` e `/admin/kommo-salesbots` que ainda não recebem unit.
// ---------------------------------------------------------------------------

let envClient: KommoClient | null = null;

export function getEnvKommoClient(): KommoClient {
  if (!envClient) {
    const creds = credsFromEnv();
    envClient = new KommoClient(creds, buildHttp(creds));
  }
  return envClient;
}

/** Compat: objeto-chamada idêntico ao antigo `KommoService.X(...)`. */
export const KommoService = {
  getLead: (leadId: number) => getEnvKommoClient().getLead(leadId),
  listLeadCustomFields: () => getEnvKommoClient().listLeadCustomFields(),
  listSalesbots: () => getEnvKommoClient().listSalesbots(),
  addTag: (p: AddTagParams) => getEnvKommoClient().addTag(p),
  moveStage: (p: MoveStageParams) => getEnvKommoClient().moveStage(p),
  sendChatReply: (p: SendChatReplyParams) => getEnvKommoClient().sendChatReply(p),
  runSalesbot: (p: {
    leadId: number;
    salesbotId: number;
    replyFieldId: number;
    text: string;
  }) => getEnvKommoClient().runSalesbot(p),
};

export type KommoServiceType = typeof KommoService;
