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

export interface KommoCustomFieldValue {
  field_id: number;
  field_name?: string;
  field_code?: string | null;
  field_type?: string;
  values: Array<{ value: unknown }>;
}

export interface KommoLead {
  id: number;
  name: string;
  status_id: number;
  pipeline_id: number;
  price?: number;
  custom_fields_values?: KommoCustomFieldValue[] | null;
  _embedded?: {
    tags?: Array<{ id: number; name: string }>;
    contacts?: Array<{ id: number }>;
  };
}

export interface KommoPipelineStatus {
  id: number;
  name: string;
  sort?: number;
  is_editable?: boolean;
  color?: string;
  type?: number;
}

export interface KommoPipeline {
  id: number;
  name: string;
  is_main?: boolean;
  is_archive?: boolean;
  sort?: number;
  statuses: KommoPipelineStatus[];
}

export interface KommoCustomField {
  id: number;
  name: string;
  type: string;
  code?: string | null;
}

export interface KommoSalesbot {
  id: number;
  name: string;
}

export interface KommoTag {
  id: number;
  name: string;
  color?: string | null;
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

  /**
   * Lista Salesbots da conta. Kommo expõe via `/api/v4/salesbots` (plural),
   * conforme https://developers.kommo.com/reference/list-of-bots — algumas
   * versões antigas usavam `/salesbot` (singular) que agora retorna 404.
   * Fallback transparente: se plural 404, tenta singular.
   */
  async listSalesbots(): Promise<unknown> {
    try {
      const { data } = await this.http.get('/salesbots');
      return data;
    } catch (errPlural) {
      const pluralStatus = axios.isAxiosError(errPlural) ? errPlural.response?.status : undefined;
      if (pluralStatus === 404) {
        try {
          const { data } = await this.http.get('/salesbot');
          return data;
        } catch (errSingular) {
          wrapAxiosError(errSingular, 'listSalesbots (fallback singular)');
        }
      }
      wrapAxiosError(errPlural, 'listSalesbots');
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

  /**
   * Lista TODOS os leads paginando até `maxPages` (default 4 = 1000 leads).
   * Usado pelo dashboard pra contar leads por etapa do funil. NÃO traz custom
   * fields nem tags pra ficar leve.
   */
  async listLeads(maxPages: number = 4): Promise<KommoLead[]> {
    const all: KommoLead[] = [];
    for (let page = 1; page <= maxPages; page++) {
      try {
        const { data } = await this.http.get<{
          _embedded?: { leads?: KommoLead[] };
          _links?: { next?: { href: string } };
        }>('/leads', { params: { page, limit: 250 } });
        const leads = data?._embedded?.leads ?? [];
        all.push(...leads);
        if (!data?._links?.next || leads.length === 0) break;
      } catch (err) {
        if (page === 1) wrapAxiosError(err, 'listLeads');
        break;
      }
    }
    return all;
  }

  /**
   * Lista pipelines do CRM com suas etapas (statuses) embedadas.
   * Usado pelo painel pra mostrar quais IDs colocar no prompt e em
   * `kommoWonStatusIds`.
   */
  async listPipelines(): Promise<KommoPipeline[]> {
    try {
      const { data } = await this.http.get<{
        _embedded?: {
          pipelines?: Array<{
            id: number;
            name: string;
            is_main?: boolean;
            is_archive?: boolean;
            sort?: number;
            _embedded?: { statuses?: KommoPipelineStatus[] };
          }>;
        };
      }>('/leads/pipelines');
      const pipelines = data?._embedded?.pipelines ?? [];
      return pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        is_main: p.is_main,
        is_archive: p.is_archive,
        sort: p.sort,
        statuses: p._embedded?.statuses ?? [],
      }));
    } catch (err) {
      wrapAxiosError(err, 'listPipelines');
    }
  }

  /**
   * Lê o lead e retorna o valor de um custom field específico como boolean.
   * Trata Kommo checkbox quirks: o value pode vir como true/false/"1"/"0"/null.
   * Retorna false quando o field não existe no lead (não estourar pausa por
   * ausência).
   */
  async isLeadFieldChecked(leadId: number, fieldId: number): Promise<boolean> {
    let lead: KommoLead;
    try {
      lead = (await this.http.get<KommoLead>(`/leads/${leadId}`)).data;
    } catch (err) {
      wrapAxiosError(err, `isLeadFieldChecked:getLead(${leadId})`);
    }
    const fv = lead.custom_fields_values?.find((f) => f.field_id === fieldId);
    if (!fv) return false;
    const raw = fv.values?.[0]?.value;
    if (raw === true) return true;
    if (typeof raw === 'string') return raw === 'true' || raw === '1';
    if (typeof raw === 'number') return raw === 1;
    return false;
  }

  /** Escreve um boolean num custom field do lead (usado pela tool `pausar_ia`). */
  async setLeadFieldFlag(leadId: number, fieldId: number, value: boolean): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, {
        custom_fields_values: [{ field_id: fieldId, values: [{ value }] }],
      });
    } catch (err) {
      wrapAxiosError(err, `setLeadFieldFlag(${leadId}, ${fieldId}, ${value})`);
    }
  }

  /** Validação: tenta buscar um custom field por ID. 404 → não existe. */
  async getCustomField(fieldId: number): Promise<KommoCustomField> {
    try {
      const { data } = await this.http.get<KommoCustomField>(`/leads/custom_fields/${fieldId}`);
      return data;
    } catch (err) {
      wrapAxiosError(err, `getCustomField(${fieldId})`);
    }
  }

  /**
   * Lista tags de leads. Kommo pagina (limit 250). Buscamos até 4 páginas
   * (1000 tags) — suficiente pra qualquer conta normal.
   */
  async listLeadTags(): Promise<KommoTag[]> {
    const all: KommoTag[] = [];
    for (let page = 1; page <= 4; page++) {
      try {
        const { data } = await this.http.get<{
          _embedded?: { tags?: KommoTag[] };
          _links?: { next?: { href: string } };
        }>('/leads/tags', { params: { page, limit: 250 } });
        const tags = data?._embedded?.tags ?? [];
        all.push(...tags);
        if (!data?._links?.next || tags.length === 0) break;
      } catch (err) {
        if (page === 1) wrapAxiosError(err, 'listLeadTags');
        break;
      }
    }
    return all;
  }

  /** Validação: tenta buscar um Salesbot por ID. */
  async getSalesbot(salesbotId: number): Promise<KommoSalesbot> {
    try {
      const { data } = await this.http.get<KommoSalesbot>(`/salesbot/${salesbotId}`);
      return data;
    } catch (err) {
      wrapAxiosError(err, `getSalesbot(${salesbotId})`);
    }
  }

  /**
   * Estratégia em duas etapas, do mais geral pro mais específico:
   *  1. PATCH no custom field "Resposta IA" — SEMPRE. Esse é o evento que o
   *     Digital Pipeline do Kommo escuta com o trigger "Quando campo muda"
   *     pra disparar o Salesbot automaticamente. É a fonte da verdade.
   *  2. POST /salesbot/{id}/run — best-effort. Algumas contas (ex:
   *     hmtecnologiakommon) retornam 404 nesse endpoint, mas continuam
   *     enviando via Digital Pipeline. Por isso engolimos o 404 silenciosa-
   *     mente — outros erros (401, 500) continuam propagando.
   *
   * Resultado: o PATCH bem-sucedido conta como salesbot disparado. Sem o
   * 404 do POST/run abortar o caminho e fazer cair pro fallback de nota.
   */
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
      return { runApi: 'ok', data };
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 404) {
        // Conta não expõe o endpoint /run via REST. O trigger do Digital
        // Pipeline cuida do disparo. Não é falha — é o caminho esperado.
        logger.debug(
          { leadId, salesbotId },
          'runSalesbot: POST /run 404 (conta sem API). Confiando no Digital Pipeline trigger.',
        );
        return { runApi: 'unavailable_404', triggeredBy: 'field_change' };
      }
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

/**
 * Checa se o lead tem o checkbox "IA Pausada" marcado no Kommo.
 *
 * Retorna `false` quando: a Unit não tem `kommoPausedFieldId` configurado,
 * o Kommo está indisponível, ou o field não está checado. Falha SILENCIOSA
 * é proposital — se a checagem cair, melhor a IA responder do que ficar mudo.
 */
export async function isLeadPaused(
  unit: Pick<Unit, 'kommoSubdomain' | 'kommoAccessToken' | 'kommoSalesbotId' | 'kommoReplyFieldId' | 'kommoPausedFieldId'>,
  leadId: number,
): Promise<boolean> {
  if (!unit.kommoPausedFieldId) return false;
  try {
    const client = createKommoClient(unit);
    return await client.isLeadFieldChecked(leadId, unit.kommoPausedFieldId);
  } catch (err) {
    logger.warn({ err, leadId, unit: unit.kommoSubdomain }, 'isLeadPaused: falha — assumindo não pausado');
    return false;
  }
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
