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

export interface SendChatReplyParams {
  leadId: number;
  text: string;
  /** UUID do chat do paciente (vem em message.add[].chat_id do webhook). */
  chatId: string | null;
  /** ID numérico da conversa em andamento (vem em message.add[].talk_id). */
  talkId: string | null;
  /** ID do contato (vem em message.add[].contact_id). */
  contactId: string | null;
}

/** Indica POR ONDE a resposta foi entregue ao Kommo. */
export type SendChatReplyVia = 'salesbot' | 'chat_message' | 'lead_note';

export interface SendChatReplyResult {
  via: SendChatReplyVia;
  detail?: unknown;
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
   * Lista todos os custom fields de leads. Útil pra descobrir IDs sem
   * precisar caçar na UI do Kommo. Consumido pelo endpoint /admin/kommo-fields.
   */
  async listLeadCustomFields(): Promise<unknown> {
    try {
      const { data } = await http.get('/leads/custom_fields', {
        params: { limit: 250 },
      });
      return data;
    } catch (err) {
      wrapAxiosError(err, 'listLeadCustomFields');
    }
  },

  /**
   * Lista todos os Salesbots. Útil pra descobrir o salesbot_id pela API.
   */
  async listSalesbots(): Promise<unknown> {
    try {
      const { data } = await http.get('/salesbot');
      return data;
    } catch (err) {
      wrapAxiosError(err, 'listSalesbots');
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

  /**
   * Dispara um Salesbot manualmente via API. Útil pra "emular" envio de
   * mensagem ao paciente em contas com WABA nativo: o backend grava o texto
   * num custom field do lead e o Salesbot lê esse campo + envia.
   *
   * O Salesbot precisa estar configurado no Kommo com UM bloco "Enviar
   * mensagem" cujo conteúdo é a variável `{{lead.cf.<replyFieldId>}}`.
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
    // Passo 1: grava o texto da resposta no custom field do lead.
    try {
      await http.patch(`/leads/${leadId}`, {
        custom_fields_values: [
          {
            field_id: replyFieldId,
            values: [{ value: text }],
          },
        ],
      });
    } catch (err) {
      wrapAxiosError(err, `runSalesbot:setField(${leadId}, field=${replyFieldId})`);
    }

    // Passo 2: dispara o Salesbot pra esse lead.
    // entity_type=2 → lead (1=contact, 2=lead, 3=company na Kommo).
    try {
      const { data } = await http.post(`/salesbot/${salesbotId}/run`, [
        {
          bot_id: salesbotId,
          entity_type: 2,
          entity_id: leadId,
        },
      ]);
      return data;
    } catch (err) {
      wrapAxiosError(err, `runSalesbot:run(${leadId}, bot=${salesbotId})`);
    }
  },

  /**
   * Envia a resposta da IA de volta ao paciente.
   *
   * IMPORTANTE — limitação do canal nativo de WhatsApp (WABA) integrado pelo
   * próprio Kommo: a API v4 NÃO expõe endpoint público confiável pra enviar
   * mensagem outbound num chat WABA gerenciado por eles. O caminho oficial é
   * via Salesbot OU via canal customizado registrado na Chats API
   * (amojo.kommo.com), que requer channel_secret próprio.
   *
   * Estratégia adotada aqui (defensiva, em camadas):
   *
   *   1. SE KOMMO_SALESBOT_ID + KOMMO_REPLY_FIELD_ID estão setadas, dispara
   *      o Salesbot via API — caminho oficial pra entregar a mensagem ao
   *      paciente em contas com WABA nativo. **É o que provavelmente vai
   *      funcionar.**
   *
   *   2. TENTA `POST /api/v4/chats/{chat_id}/messages` — endpoint não
   *      documentado, raro funcionar com WABA. Mantido por compatibilidade
   *      com contas em canais customizados.
   *
   *   3. CAI PRA criar uma nota comum no lead. Sempre funciona, mas a nota
   *      fica visível só no painel pro operador (não dispara WhatsApp).
   *
   * Retorna `via` indicando qual caminho funcionou, pra o trace do dashboard
   * mostrar se a mensagem chegou ao paciente ou só foi registrada internamente.
   */
  async sendChatReply({
    leadId,
    text,
    chatId,
    talkId,
    contactId,
  }: SendChatReplyParams): Promise<SendChatReplyResult> {
    // Tentativa 1: Salesbot (se env configurada).
    if (env.KOMMO_SALESBOT_ID && env.KOMMO_REPLY_FIELD_ID) {
      try {
        const data = await this.runSalesbot({
          leadId,
          salesbotId: env.KOMMO_SALESBOT_ID,
          replyFieldId: env.KOMMO_REPLY_FIELD_ID,
          text,
        });
        logger.info({ leadId, salesbotId: env.KOMMO_SALESBOT_ID }, 'kommo salesbot disparado');
        return { via: 'salesbot', detail: data };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        logger.warn({ err, leadId, status }, 'salesbot falhou, tentando outros caminhos');
      }
    }

    // Tentativa 2: enviar como mensagem de chat (só se temos chat_id).
    if (chatId) {
      try {
        const { data } = await http.post(`/chats/${chatId}/messages`, {
          text,
          ...(talkId ? { talk_id: talkId } : {}),
          ...(contactId ? { contact_id: contactId } : {}),
        });
        logger.info({ leadId, chatId, talkId }, 'kommo chat message enviada');
        return { via: 'chat_message', detail: data };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        logger.debug(
          { err, leadId, chatId, status },
          'chats/{id}/messages falhou, caindo pra nota',
        );
      }
    }

    // Tentativa 3 (fallback): cria uma nota no lead com a resposta da IA.
    try {
      const { data } = await http.post(`/leads/${leadId}/notes`, [
        {
          note_type: 'common',
          params: { text: `🤖 Sofia (IA): ${text}` },
        },
      ]);
      logger.info({ leadId }, 'kommo nota criada com resposta da IA');
      return { via: 'lead_note', detail: data };
    } catch (err) {
      wrapAxiosError(err, `sendChatReply(${leadId})`);
    }
  },
};

export type KommoServiceType = typeof KommoService;
