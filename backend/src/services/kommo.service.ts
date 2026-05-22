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
  /** Unix timestamp em segundos (Kommo retorna assim). */
  created_at?: number;
  updated_at?: number;
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

// ---------------------------------------------------------------------------
// Custom field types: o que a gente expõe na UI de Captura de Dados.
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

export const SUPPORTED_FIELD_TYPES: ReadonlySet<string> = new Set<KommoFieldType>([
  'text',
  'textarea',
  'numeric',
  'date',
  'birthday',
  'select',
  'multiselect',
  'radiobutton',
]);

export interface KommoLeadCustomField {
  id: number;
  name: string;
  type: KommoFieldType;
  code: string | null;
  /** Só pra select/multiselect/radiobutton — opções disponíveis. */
  enums: Array<{ id: number; value: string }>;
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

/** Interface mínima do recorder pra evitar import circular. */
export interface KommoStepRecorder {
  step(args: {
    kind: 'KOMMO_ACTION' | 'ERROR';
    title: string;
    payload?: unknown;
    latencyMs?: number;
  }): Promise<void>;
}

export interface SendChatReplyParams {
  leadId: number;
  text: string;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  /** Opcional: se passado, cada operação Kommo vira um step no painel. */
  recorder?: KommoStepRecorder;
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
// stripEmojis — remove emojis e símbolos pictográficos do texto.
//
// O Salesbot do Kommo (rota PATCH no campo "Resposta IA" + POST /salesbot/run)
// tem um bug conhecido: trunca tudo que vem depois do primeiro caractere
// multibyte UTF-8 (emoji). "Boa tarde! 🌼 Como posso..." chega como "Boa tarde!".
//
// Pra essa rota, removemos emojis preservando o texto. Quem quiser MANTER
// emojis no WhatsApp final tem que ativar `kommoBypassSalesbot` na Unit, que
// envia direto via /chats/{chatId}/messages (sem passar pelo Salesbot).
//
// Regex cobre: emoticons, símbolos & pictograms, transportes, bandeiras,
// flags compostas, ZWJ sequences. Mantém pontuação ASCII e letras com acento.
// ---------------------------------------------------------------------------

export function stripEmojis(text: string): string {
  // Unicode property escape — suporte em todos os Node ≥ 12.
  // - \p{Extended_Pictographic}: emoticons, símbolos pictográficos, transportes
  // - \p{Regional_Indicator}: pares que formam bandeiras (🇧🇷, 🇺🇸, …)
  // - ZWJ + variation selectors + skin tone modifiers: removidos juntos
  return text
    .replace(/\p{Extended_Pictographic}(‍\p{Extended_Pictographic})*[️‍]*/gu, '')
    .replace(/\p{Regional_Indicator}{2}/gu, '')
    .replace(/[️‍\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/ {2,}/g, ' ') // colapsa espaços extras deixados pela remoção
    .trim();
}

// ---------------------------------------------------------------------------
// downgradeEmoji — substitui emoji 4-byte por equivalentes do BMP (3-byte).
//
// Por que existe: o storage do Kommo (custom_fields_values e provavelmente
// outros campos texto) usa MySQL com collation `utf8` (3 bytes), que trunca
// silenciosamente strings no primeiro code point >= U+10000. Diagnóstico
// confirmado pelo readback em runSalesbot: "Boa noite! 🌙 Como posso..."
// chega como "Boa noite! " (corte EXATO no emoji).
//
// Diferente de `stripEmojis`, aqui preservamos a vibe da mensagem: mapeamos
// o emoji 4-byte pro símbolo BMP mais próximo (☾, ☺, ♥, …). O que sobra
// fora do mapa é stripado pra impedir a truncagem.
//
// Tabela enxuta de propósito: só os emoji que o agente costuma emitir.
// Quando notar um emoji novo "sumindo" no readback, adiciona aqui.
// ---------------------------------------------------------------------------

const EMOJI_BMP_DOWNGRADE: ReadonlyMap<string, string> = new Map([
  // Lua / noite
  ['🌙', '☾'], ['🌛', '☾'], ['🌜', '☾'], ['🌚', '☾'], ['🌝', '☾'],
  // Sol / dia
  ['🌞', '☀'], ['🌅', '☀'], ['🌄', '☀'],
  // Sorriso / positivo
  ['😊', '☺'], ['😀', '☺'], ['😃', '☺'], ['😄', '☺'], ['🙂', '☺'], ['😁', '☺'],
  // Tristeza / negativo
  ['😢', '☹'], ['😞', '☹'], ['😔', '☹'], ['🙁', '☹'], ['😟', '☹'],
  // Coração (todas as cores → ♥)
  ['❤', '♥'], ['💜', '♥'], ['💙', '♥'], ['💚', '♥'], ['💛', '♥'],
  ['🤍', '♥'], ['🖤', '♥'], ['🤎', '♥'], ['💕', '♥'], ['💖', '♥'],
  ['💗', '♥'], ['💓', '♥'], ['💝', '♥'],
  // Telefone / contato
  ['📞', '☎'], ['📱', '☎'], ['📲', '☎'],
  // Saúde / clínica (caduceu BMP)
  ['🏥', '⚕'], ['💊', '⚕'], ['💉', '⚕'], ['🩺', '⚕'], ['🩹', '⚕'],
  // Estrelas
  ['🌟', '★'], ['⭐', '★'], ['🌠', '★'], ['💫', '★'],
  // Mão / aprovação
  ['👍', '✔'], ['👌', '✔'], ['🙌', '✔'], ['🤝', '✔'],
  // Reprovação
  ['👎', '✖'],
  // Relógio
  ['⏰', '⌚'], ['⏱', '⌚'], ['🕐', '⌚'], ['🕑', '⌚'], ['🕒', '⌚'],
  // Fogo / atenção
  ['🔥', '※'], ['⚠', '⚠'],
  // Apontando
  ['👉', '➤'], ['👈', '◀'], ['👇', '▼'], ['☝', '☝'],
  // Setas comuns
  ['↗', '↗'], ['↘', '↘'],
  // Festa / sucesso
  ['🎉', '✨'], ['🎊', '✨'], ['✨', '✨'],
  // Calendário / agendamento
  ['📅', '✎'], ['📆', '✎'], ['🗓', '✎'], ['📝', '✎'], ['✏', '✎'],
]);

export function downgradeEmoji(text: string): string {
  let out = text;
  for (const [from, to] of EMOJI_BMP_DOWNGRADE) {
    if (out.includes(from)) out = out.replaceAll(from, to);
  }
  // Sobra (qualquer emoji 4-byte fora do mapa) → strip silencioso pra
  // não engatilhar a truncagem do Kommo. Inclui variation selectors
  // (FE0E/FE0F) órfãos que podem sobrar depois das substituições.
  out = out.replace(/[\u{10000}-\u{10FFFF}]/gu, '');
  out = out.replace(/[︎️]/g, '');
  return out;
}

// ---------------------------------------------------------------------------
// splitIntoChunks — quebra texto longo em pedaços ≤ maxLen respeitando
// fronteiras naturais (parágrafo > frase > palavra).
//
// O campo "Resposta IA" do Kommo (custom field type=text) trunca silenciosa-
// mente em ~250 chars. Esta função produz N pedaços que são enviados em
// sequência pelo sendChatReply, simulando vários balões de WhatsApp.
// ---------------------------------------------------------------------------

export function splitIntoChunks(text: string, maxLen: number): string[] {
  const clean = text.trim();
  if (clean.length === 0) return [];
  if (clean.length <= maxLen) return [clean];

  const chunks: string[] = [];
  let remaining = clean;

  while (remaining.length > maxLen) {
    let cut = maxLen;
    // Tenta cortar no último final de sentença antes do limite.
    const slice = remaining.slice(0, maxLen);
    const lastBoundary = Math.max(
      slice.lastIndexOf('\n\n'),
      slice.lastIndexOf('. '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('! '),
    );
    if (lastBoundary > maxLen * 0.5) {
      cut = lastBoundary + 1; // inclui o '.', '?' ou '!'
    } else {
      // Sem fim-de-sentença útil — corta no último espaço pra não rachar palavra.
      const lastSpace = slice.lastIndexOf(' ');
      if (lastSpace > maxLen * 0.5) cut = lastSpace;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ---------------------------------------------------------------------------
// Config interna do cliente — derivada de uma Unit ou do env legado.
// ---------------------------------------------------------------------------

interface KommoCreds {
  subdomain: string;
  accessToken: string;
  salesbotId: number | null;
  replyFieldId: number | null;
  bypassSalesbot: boolean;
}

function credsFromUnit(
  unit: Pick<
    Unit,
    | 'kommoSubdomain'
    | 'kommoAccessToken'
    | 'kommoSalesbotId'
    | 'kommoReplyFieldId'
    | 'kommoBypassSalesbot'
  >,
): KommoCreds {
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    throw new Error('Unit sem credenciais Kommo configuradas');
  }
  return {
    subdomain: unit.kommoSubdomain,
    accessToken: unit.kommoAccessToken,
    salesbotId: unit.kommoSalesbotId,
    replyFieldId: unit.kommoReplyFieldId,
    bypassSalesbot: unit.kommoBypassSalesbot ?? false,
  };
}

function credsFromEnv(): KommoCreds {
  return {
    subdomain: env.KOMMO_SUBDOMAIN,
    accessToken: env.KOMMO_ACCESS_TOKEN,
    salesbotId: env.KOMMO_SALESBOT_ID ?? null,
    replyFieldId: env.KOMMO_REPLY_FIELD_ID ?? null,
    bypassSalesbot: false,
  };
}

function buildHttp(creds: KommoCreds): AxiosInstance {
  const http = axios.create({
    baseURL: `https://${creds.subdomain}.kommo.com/api/v4`,
    timeout: 15_000,
    // RFC 8259 já manda `application/json` ser UTF-8, mas alguns proxies/CDNs
    // na frente do Kommo tratam como ASCII quando não tem charset explícito.
    // Forçar elimina ambiguidade.
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      'Accept-Charset': 'utf-8',
    },
    // Garante que o axios serialize o JSON via JSON.stringify nativo (UTF-16
    // → UTF-8 limpo), sem passar por encoders legados que podem stripar
    // surrogate pairs (que é como os emojis fora do BMP são representados).
    responseType: 'json',
  });

  http.interceptors.request.use((config) => {
    (config as { metadata?: { start: number } }).metadata = { start: performance.now() };
    // Log defensivo: serializa o body como UTF-8 buffer e mostra os bytes
    // do emoji se houver. Útil quando o paciente reclama "não chegou emoji".
    if (config.data && typeof config.data === 'object') {
      const json = JSON.stringify(config.data);
      const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(json);
      if (hasEmoji) {
        const bytes = Buffer.byteLength(json, 'utf8');
        logger.debug(
          {
            url: config.url,
            method: config.method,
            jsonLen: json.length,
            bytes,
            preview: json.slice(0, 200),
          },
          'kommo http: payload contém emoji, mandando como UTF-8',
        );
      }
    }
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
   * Lista os custom fields de lead já normalizados pra UI: { id, name, type,
   * code, enums?: [{id, value}] }. Apaga campos que a gente não suporta na
   * UI de regras (smart_address, items, etc — exigem schema complexo).
   */
  async listLeadCustomFieldsTyped(): Promise<KommoLeadCustomField[]> {
    const raw = (await this.listLeadCustomFields()) as {
      _embedded?: {
        custom_fields?: Array<{
          id: number;
          name: string;
          type: string;
          code?: string | null;
          enums?: Array<{ id: number; value: string; sort?: number }> | null;
        }>;
      };
    };
    const all = raw?._embedded?.custom_fields ?? [];
    return all
      .filter((f) => SUPPORTED_FIELD_TYPES.has(f.type))
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type as KommoLeadCustomField['type'],
        code: f.code ?? null,
        enums: (f.enums ?? [])
          .slice()
          .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
          .map((e) => ({ id: e.id, value: e.value })),
      }));
  }

  /**
   * Escreve um valor em um custom field de lead. O formato do `values[0]`
   * varia por tipo — encapsulamos aqui pra que o caller (tool) só passe
   * { fieldId, type, value } e a gente cuida da serialização.
   *
   * Tipos suportados:
   *  - text/textarea       → values: [{ value: string }]
   *  - numeric             → values: [{ value: number }]
   *  - date/birthday       → values: [{ value: unix seconds }]
   *  - select/radiobutton  → values: [{ enum_id }] ou [{ value: enumLabel }]
   *  - multiselect         → values: enums.map(e => ({ enum_id }))
   *
   * Aplica downgradeEmoji em valores string pra evitar truncagem (mesma
   * razão do PATCH no campo "Resposta IA" — bug do MySQL utf8).
   */
  async setLeadCustomFieldValue(
    leadId: number,
    fieldId: number,
    fieldType: KommoFieldType,
    value: string | number | string[],
  ): Promise<void> {
    let values: Array<Record<string, unknown>>;

    if (fieldType === 'text' || fieldType === 'textarea') {
      if (typeof value !== 'string') {
        throw new Error(`field ${fieldId} (${fieldType}) requer string, recebeu ${typeof value}`);
      }
      values = [{ value: downgradeEmoji(value) }];
    } else if (fieldType === 'numeric') {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) {
        throw new Error(`field ${fieldId} (numeric) recebeu valor não-numérico: ${value}`);
      }
      values = [{ value: num }];
    } else if (fieldType === 'date' || fieldType === 'birthday') {
      // Kommo espera unix seconds. Aceita ISO string ou number ms/seconds.
      let unixSec: number;
      if (typeof value === 'number') {
        unixSec = value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
      } else if (typeof value === 'string') {
        const parsed = new Date(value).getTime();
        if (!Number.isFinite(parsed)) {
          throw new Error(`field ${fieldId} (${fieldType}) ISO inválido: ${value}`);
        }
        unixSec = Math.floor(parsed / 1000);
      } else {
        throw new Error(`field ${fieldId} (${fieldType}) requer ISO string ou number`);
      }
      values = [{ value: unixSec }];
    } else if (fieldType === 'select' || fieldType === 'radiobutton') {
      // Aceita label (string) — Kommo casa pelo `value` se enum_id não vier.
      if (typeof value !== 'string') {
        throw new Error(`field ${fieldId} (${fieldType}) requer string (label da opção)`);
      }
      values = [{ value: downgradeEmoji(value) }];
    } else if (fieldType === 'multiselect') {
      const arr = Array.isArray(value) ? value : [value];
      values = arr.map((v) => ({ value: downgradeEmoji(String(v)) }));
    } else {
      throw new Error(`field ${fieldId} tipo não suportado: ${fieldType}`);
    }

    try {
      await this.http.patch(`/leads/${leadId}`, {
        custom_fields_values: [{ field_id: fieldId, values }],
      });
    } catch (err) {
      wrapAxiosError(
        err,
        `setLeadCustomFieldValue(${leadId}, field=${fieldId}, type=${fieldType})`,
      );
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

  /**
   * Remove uma tag específica do lead. Kommo aceita o atalho
   * `_embedded.tags_to_delete: [{ name }]` que remove sem mexer no resto.
   * Idempotente: remover tag que não existe é no-op (Kommo retorna 200).
   */
  async removeTag(leadId: number, tag: string): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, {
        _embedded: { tags_to_delete: [{ name: tag }] },
      });
    } catch (err) {
      wrapAxiosError(err, `removeTag(${leadId}, ${tag})`);
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

  /** Define o responsável (usuário Kommo) pelo lead. */
  async setLeadResponsible(leadId: number, userId: number): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, { responsible_user_id: userId });
    } catch (err) {
      wrapAxiosError(err, `setLeadResponsible(${leadId}, user=${userId})`);
    }
  }

  /** Define o valor (preço) do lead em reais inteiros (Kommo armazena number). */
  async setLeadPrice(leadId: number, price: number): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, { price });
    } catch (err) {
      wrapAxiosError(err, `setLeadPrice(${leadId}, price=${price})`);
    }
  }

  /**
   * Fecha o lead como WON ou LOST. Kommo trata isso via status_id =
   * 142 (lost) ou 143 (won) — IDs fixos por convenção.
   *
   * `lossReasonId` é opcional pra LOST: identifica POR QUE perdeu (ex:
   * "Sem orçamento", "Concorrente"). Os IDs vêm de /leads/loss_reasons.
   */
  async setLeadStatus(
    leadId: number,
    options: { won: boolean; lossReasonId?: number },
  ): Promise<void> {
    // IDs fixos da Kommo:
    //   142 = SUCCESSFUL (Venda Realizada / Won)
    //   143 = UNSUCCESSFUL (Venda Perdida / Lost)
    const statusId = options.won ? 142 : 143;
    const body: Record<string, unknown> = { status_id: statusId };
    if (!options.won && options.lossReasonId) body.loss_reason_id = options.lossReasonId;
    try {
      await this.http.patch(`/leads/${leadId}`, body);
    } catch (err) {
      wrapAxiosError(err, `setLeadStatus(${leadId}, won=${options.won})`);
    }
  }

  /**
   * Move lead pra outro pipeline. Se `statusId` não vier, Kommo coloca no
   * primeiro status do pipeline destino automaticamente.
   */
  async setLeadPipeline(
    leadId: number,
    pipelineId: number,
    statusId?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = { pipeline_id: pipelineId };
    if (statusId) body.status_id = statusId;
    try {
      await this.http.patch(`/leads/${leadId}`, body);
    } catch (err) {
      wrapAxiosError(err, `setLeadPipeline(${leadId}, pipeline=${pipelineId})`);
    }
  }

  /**
   * Cria tarefa no Kommo vinculada ao lead. `completeAt` em unix seconds
   * (Kommo usa segundos, não ms). `responsibleUserId` opcional — sem ele,
   * herda do responsável do lead.
   */
  async createTask(args: {
    leadId: number;
    text: string;
    completeAt: number;
    responsibleUserId?: number;
    taskTypeId?: number;
  }): Promise<{ id?: number } | null> {
    const body = [
      {
        entity_id: args.leadId,
        entity_type: 'leads',
        text: downgradeEmoji(args.text),
        complete_till: args.completeAt,
        ...(args.responsibleUserId ? { responsible_user_id: args.responsibleUserId } : {}),
        ...(args.taskTypeId ? { task_type_id: args.taskTypeId } : {}),
      },
    ];
    try {
      const { data } = await this.http.post<{ _embedded?: { tasks?: Array<{ id: number }> } }>(
        '/tasks',
        body,
      );
      const id = data?._embedded?.tasks?.[0]?.id;
      return id ? { id } : null;
    } catch (err) {
      wrapAxiosError(err, `createTask(${args.leadId})`);
    }
  }

  /** Lista usuários da conta Kommo. Usado pelo picker de "responsável". */
  async listUsers(): Promise<Array<{ id: number; name: string; email?: string }>> {
    try {
      const { data } = await this.http.get<{
        _embedded?: { users?: Array<{ id: number; name: string; email?: string }> };
      }>('/users', { params: { page: 1, limit: 250 } });
      return data?._embedded?.users ?? [];
    } catch (err) {
      wrapAxiosError(err, 'listUsers');
    }
  }

  /** Lista loss_reasons (motivos de perda) — usado pelo picker do fechar lead. */
  async listLossReasons(): Promise<Array<{ id: number; name: string }>> {
    try {
      const { data } = await this.http.get<{
        _embedded?: { loss_reasons?: Array<{ id: number; name: string }> };
      }>('/leads/loss_reasons', { params: { page: 1, limit: 250 } });
      return data?._embedded?.loss_reasons ?? [];
    } catch (err) {
      wrapAxiosError(err, 'listLossReasons');
    }
  }

  /**
   * Atualiza o `name` do lead — que é o que aparece como título no Kommo.
   * Usado pela tool `atualizar_titulo_lead` quando a IA descobre o nome real
   * do paciente e quer trocar o título genérico ("WhatsApp Web", "Visitante").
   */
  async updateLeadName(leadId: number, name: string): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, { name });
    } catch (err) {
      wrapAxiosError(err, `updateLeadName(${leadId}, ${name})`);
    }
  }

  /**
   * Posta uma nota interna no lead. Aparece no painel do Kommo pros operadores
   * humanos (SDR, vendedor) mas NÃO é enviada pro paciente.
   *
   * Usado pela tool `resumir_lead_para_sdr` pra registrar o resumo gerado
   * pela IA. O texto passa por downgradeEmoji por garantia (Kommo trunca
   * 4-byte emoji).
   */
  async addLeadNote(leadId: number, text: string): Promise<{ id?: number } | null> {
    try {
      const { data } = await this.http.post<{
        _embedded?: { notes?: Array<{ id: number }> };
      }>(`/leads/${leadId}/notes`, [
        { note_type: 'common', params: { text: downgradeEmoji(text) } },
      ]);
      const id = data?._embedded?.notes?.[0]?.id;
      return id ? { id } : null;
    } catch (err) {
      wrapAxiosError(err, `addLeadNote(${leadId})`);
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
    recorder,
  }: {
    leadId: number;
    salesbotId: number;
    replyFieldId: number;
    text: string;
    recorder?: KommoStepRecorder;
  }): Promise<unknown> {
    // ⚠ ATENÇÃO À DUPLICAÇÃO: este método dispara o salesbot por DOIS caminhos:
    //   1. PATCH no campo "Resposta IA" — se o Digital Pipeline do Kommo está
    //      configurado pra "Quando campo muda → rodar Salesbot", esse PATCH
    //      sozinho JÁ envia a mensagem.
    //   2. POST /salesbot/{id}/run — também dispara.
    // Se AMBOS os gatilhos estão ativos, o paciente recebe a mensagem 2x.
    // Os logs abaixo permitem ver o duplo disparo: se o POST retornou 200
    // (não 404) E o paciente recebeu 2 mensagens, desabilite o trigger do
    // Digital Pipeline ou troque o `kommoReplyFieldId` por um campo "burro"
    // (sem trigger do DP).
    const t0Patch = performance.now();
    try {
      // Downgrade 4-byte emoji ANTES do envio. Kommo trunca a string no
      // primeiro char fora do BMP (bug de utf8 vs utf8mb4 no storage deles).
      const safeText = downgradeEmoji(text);
      const wasDowngraded = safeText !== text;
      const sentBytes = Buffer.byteLength(safeText, 'utf8');
      const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(safeText);
      await this.http.patch(`/leads/${leadId}`, {
        custom_fields_values: [{ field_id: replyFieldId, values: [{ value: safeText }] }],
      });
      const patchMs = Math.round(performance.now() - t0Patch);
      logger.info(
        {
          leadId,
          replyFieldId,
          route: 'patch_field',
          sentText: safeText,
          originalText: wasDowngraded ? text : undefined,
          sentLen: safeText.length,
          sentBytes,
          hasEmoji,
          wasDowngraded,
        },
        'runSalesbot: PATCH no campo Resposta IA enviado',
      );
      await recorder?.step({
        kind: 'KOMMO_ACTION',
        title: `📤 PATCH "Resposta IA" — ${safeText.length} chars, ${sentBytes} bytes${hasEmoji ? ' (emoji BMP)' : ''}${wasDowngraded ? ' [downgrade]' : ''}`,
        payload: {
          leadId,
          replyFieldId,
          sentText: safeText,
          originalText: wasDowngraded ? text : undefined,
          sentLen: safeText.length,
          sentBytes,
          hasEmoji,
          wasDowngraded,
        },
        latencyMs: patchMs,
      });

      // READBACK — lê o lead de volta pra confirmar o que ficou armazenado.
      // Compara contra `safeText` (o que de fato mandamos depois do downgrade),
      // não contra `text`. Se mesmo o BMP estiver sumindo, o problema é
      // outro (ex: Kommo aplicando algum strip extra) e a gente precisa saber.
      if (hasEmoji || wasDowngraded) {
        const t0Read = performance.now();
        try {
          const { data: lead } = await this.http.get<KommoLead>(`/leads/${leadId}`);
          const readMs = Math.round(performance.now() - t0Read);
          const stored = lead.custom_fields_values?.find((f) => f.field_id === replyFieldId);
          const storedValue = stored?.values?.[0]?.value;
          const storedStr =
            typeof storedValue === 'string' ? storedValue : JSON.stringify(storedValue);
          const storedHasEmoji =
            typeof storedStr === 'string'
              ? /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(storedStr)
              : false;
          const match = storedStr === safeText;
          logger.info(
            { leadId, replyFieldId, storedValue: storedStr, storedHasEmoji, match, wasDowngraded },
            match
              ? '🟢 Kommo armazenou idêntico ao enviado (downgrade efetivo)'
              : '🔴 Storage do Kommo divergiu mesmo após downgrade — investigar',
          );
          await recorder?.step({
            kind: 'KOMMO_ACTION',
            title: match
              ? `🟢 Readback: Kommo armazenou idêntico (${storedStr.length} chars)`
              : '🔴 Readback: divergência mesmo após downgrade',
            payload: {
              sentText: safeText,
              originalText: wasDowngraded ? text : undefined,
              storedValue: storedStr,
              storedHasEmoji,
              match,
              wasDowngraded,
              diagnostico: match
                ? 'Downgrade resolveu — mensagem chegou íntegra ao Kommo.'
                : 'Mesmo com chars BMP houve perda — Kommo pode estar aplicando outro filtro de sanitização.',
            },
            latencyMs: readMs,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, leadId }, 'readback falhou — não conseguimos ler o campo de volta');
          await recorder?.step({
            kind: 'ERROR',
            title: `Readback falhou: ${msg}`,
            payload: { leadId, error: msg },
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recorder?.step({
        kind: 'ERROR',
        title: `❌ PATCH no campo "Resposta IA" falhou: ${msg}`,
        payload: { leadId, replyFieldId, error: msg },
      });
      wrapAxiosError(err, `runSalesbot:setField(${leadId}, field=${replyFieldId})`);
    }

    const t0Run = performance.now();
    try {
      const { data } = await this.http.post(`/salesbot/${salesbotId}/run`, [
        { bot_id: salesbotId, entity_type: 2, entity_id: leadId },
      ]);
      const runMs = Math.round(performance.now() - t0Run);
      logger.warn(
        { leadId, salesbotId, route: 'post_run' },
        'runSalesbot: POST /salesbot/run retornou 200 — se o Digital Pipeline também dispara o bot ao mudar Resposta IA, o paciente vai receber a mensagem 2x',
      );
      await recorder?.step({
        kind: 'KOMMO_ACTION',
        title: `⚠️ POST /salesbot/${salesbotId}/run retornou 200 — risco de disparo duplo`,
        payload: {
          leadId,
          salesbotId,
          alerta:
            'Se o Digital Pipeline também dispara este Salesbot ao mudar o campo, o paciente recebe a mensagem 2x. Considere desligar um dos gatilhos.',
        },
        latencyMs: runMs,
      });
      return { runApi: 'ok', data };
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const runMs = Math.round(performance.now() - t0Run);
      if (status === 404) {
        // Conta não expõe o endpoint /run via REST. O trigger do Digital
        // Pipeline cuida do disparo. Não é falha — é o caminho esperado.
        logger.debug(
          { leadId, salesbotId },
          'runSalesbot: POST /run 404 (conta sem API). Confiando no Digital Pipeline trigger.',
        );
        await recorder?.step({
          kind: 'KOMMO_ACTION',
          title: '🔁 POST /salesbot/run = 404 (esperado nesta conta). Digital Pipeline cuida.',
          payload: {
            leadId,
            salesbotId,
            triggeredBy: 'field_change',
            nota: 'Sua conta Kommo não expõe POST /salesbot/{id}/run. O envio acontece pelo gatilho do Digital Pipeline quando o campo "Resposta IA" muda.',
          },
          latencyMs: runMs,
        });
        return { runApi: 'unavailable_404', triggeredBy: 'field_change' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      await recorder?.step({
        kind: 'ERROR',
        title: `❌ POST /salesbot/run falhou (${status ?? 'sem status'}): ${msg}`,
        payload: { leadId, salesbotId, status, error: msg },
        latencyMs: runMs,
      });
      wrapAxiosError(err, `runSalesbot:run(${leadId}, bot=${salesbotId})`);
    }
  }

  /**
   * Envia a resposta da IA de volta ao paciente. Estratégia em camadas:
   *  1. Salesbot (se Unit tem salesbotId + replyFieldId).
   *  2. POST /chats/{chatId}/messages (raro funcionar com WABA nativo).
   *  3. Cria nota comum no lead (sempre funciona, mas só visível ao operador).
   *
   * CHUNKING: o campo "Resposta IA" do Kommo (custom field type=text) tem
   * limite ~250 chars. Se a resposta passar disso, quebramos em N pedaços
   * e disparamos o Salesbot uma vez por pedaço com 900ms entre eles — sai
   * como se a IA tivesse digitado várias mensagens.
   */
  async sendChatReply({
    leadId,
    text,
    chatId,
    talkId,
    contactId,
    recorder,
  }: SendChatReplyParams): Promise<SendChatReplyResult> {
    // ─────────────────────────────────────────────────────────────────────
    // MODO BYPASS — comportamento "edição manual": faz APENAS o PATCH no
    // campo Resposta IA e deixa o Digital Pipeline do Kommo disparar o
    // Salesbot uma única vez. Mesma rota que acontece quando o usuário
    // edita o campo na UI do Kommo. Resolve casos onde:
    //   - O Salesbot via POST /salesbot/run corrompe emoji
    //   - Há disparo duplo (DP trigger + POST /run)
    // Pré-requisito: o Digital Pipeline da Unit tem um gatilho
    // "Quando campo Resposta IA mudar → rodar Salesbot".
    // ─────────────────────────────────────────────────────────────────────
    if (this.creds.bypassSalesbot && this.creds.replyFieldId) {
      const t0 = performance.now();
      try {
        const chunks = splitIntoChunks(text, 240);
        for (let i = 0; i < chunks.length; i++) {
          await this.http.patch(`/leads/${leadId}`, {
            custom_fields_values: [
              { field_id: this.creds.replyFieldId, values: [{ value: chunks[i] }] },
            ],
          });
          if (i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, 900));
          }
        }
        const ms = Math.round(performance.now() - t0);
        logger.info(
          { leadId, replyFieldId: this.creds.replyFieldId, chunks: chunks.length, mode: 'patch_only' },
          'kommo bypass: PATCH-only no campo Resposta IA (Digital Pipeline cuida do envio)',
        );
        await recorder?.step({
          kind: 'KOMMO_ACTION',
          title: `📤 Modo "edição manual" — PATCH ${chunks.length}× no campo, Digital Pipeline cuida do envio`,
          payload: {
            mode: 'patch_only',
            chunks: chunks.length,
            sentText: text,
            leadId,
            replyFieldId: this.creds.replyFieldId,
          },
          latencyMs: ms,
        });
        return { via: 'salesbot', detail: { mode: 'patch_only', chunks: chunks.length } };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, leadId, status }, 'kommo bypass: PATCH falhou, tentando outros caminhos');
        await recorder?.step({
          kind: 'ERROR',
          title: `❌ Bypass PATCH falhou (${status ?? '?'}): ${msg}`,
          payload: { leadId, status, error: msg },
          latencyMs: Math.round(performance.now() - t0),
        });
      }
    } else if (this.creds.salesbotId && this.creds.replyFieldId) {
      try {
        const chunks = splitIntoChunks(text, 240);
        logger.debug(
          { leadId, originalText: text, chunks: chunks.length },
          'kommo salesbot: enviando resposta da IA',
        );
        let lastData: unknown = null;
        for (let i = 0; i < chunks.length; i++) {
          lastData = await this.runSalesbot({
            leadId,
            salesbotId: this.creds.salesbotId,
            replyFieldId: this.creds.replyFieldId,
            text: chunks[i],
            recorder,
          });
          if (i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, 900));
          }
        }
        logger.info(
          { leadId, salesbotId: this.creds.salesbotId, chunks: chunks.length },
          'kommo salesbot disparado',
        );
        return { via: 'salesbot', detail: lastData };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        logger.warn({ err, leadId, status }, 'salesbot falhou, tentando outros caminhos');
      }
    }

    if (chatId) {
      const t0 = performance.now();
      // Mesmo downgrade defensivo do PATCH: /chats também pode passar pelo
      // storage com utf8 (3-byte). Se na prática esse endpoint aceitar 4-byte
      // sem truncar, o downgrade só preserva consistência visual entre os
      // dois caminhos — não há regressão.
      const safeText = downgradeEmoji(text);
      const wasDowngraded = safeText !== text;
      try {
        const { data } = await this.http.post(`/chats/${chatId}/messages`, {
          text: safeText,
          ...(talkId ? { talk_id: talkId } : {}),
          ...(contactId ? { contact_id: contactId } : {}),
        });
        const ms = Math.round(performance.now() - t0);
        logger.info({ leadId, chatId, talkId, wasDowngraded }, 'kommo chat message enviada');
        await recorder?.step({
          kind: 'KOMMO_ACTION',
          title: `📨 Mensagem enviada via /chats/${chatId}/messages${wasDowngraded ? ' [downgrade]' : ''}`,
          payload: {
            leadId,
            chatId,
            talkId,
            sentText: safeText,
            originalText: wasDowngraded ? text : undefined,
            wasDowngraded,
          },
          latencyMs: ms,
        });
        return { via: 'chat_message', detail: data };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const body = axios.isAxiosError(err) ? err.response?.data : undefined;
        logger.warn(
          { leadId, chatId, talkId, status, body },
          'kommo /chats/{id}/messages falhou — caindo pra nota interna (mensagem NÃO vai pro paciente)',
        );
        await recorder?.step({
          kind: 'ERROR',
          title: `⚠️ /chats/${chatId}/messages falhou (${status ?? '?'}) — caindo pra nota interna`,
          payload: {
            leadId,
            chatId,
            status,
            body,
            atencao:
              'Sua conta Kommo não suporta esse endpoint. Mensagem vai virar nota interna (paciente NÃO recebe).',
          },
          latencyMs: Math.round(performance.now() - t0),
        });
      }
    }

    const t0Note = performance.now();
    try {
      const { data } = await this.http.post(`/leads/${leadId}/notes`, [
        { note_type: 'common', params: { text: `🤖 IA: ${text}` } },
      ]);
      const ms = Math.round(performance.now() - t0Note);
      logger.info({ leadId }, 'kommo nota criada com resposta da IA');
      await recorder?.step({
        kind: 'KOMMO_ACTION',
        title: `📝 Caiu no fallback: nota interna criada (paciente NÃO recebe)`,
        payload: {
          leadId,
          sentText: text,
          atencao:
            'Esta é a última camada de fallback. O paciente NÃO recebeu a mensagem — só ficou registrada como nota no lead pra revisão.',
        },
        latencyMs: ms,
      });
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
  unit: Pick<
    Unit,
    | 'kommoSubdomain'
    | 'kommoAccessToken'
    | 'kommoSalesbotId'
    | 'kommoReplyFieldId'
    | 'kommoBypassSalesbot'
  >,
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
  unit: Pick<
    Unit,
    | 'kommoSubdomain'
    | 'kommoAccessToken'
    | 'kommoSalesbotId'
    | 'kommoReplyFieldId'
    | 'kommoPausedFieldId'
    | 'kommoBypassSalesbot'
  >,
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
