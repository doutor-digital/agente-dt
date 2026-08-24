import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { Unit } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

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
  tag?: string;
  tags?: string[];
}

export interface MoveStageParams {
  leadId: number;
  statusId: number;
  pipelineId?: number;
}

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
  recorder?: KommoStepRecorder;
}

export type SendChatReplyVia = 'salesbot' | 'chat_message' | 'lead_note';

export interface SendChatReplyResult {
  via: SendChatReplyVia;
  detail?: unknown;
}

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

export function temPalavra(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export function stripEmojis(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}(‍\p{Extended_Pictographic})*[️‍]*/gu, '')
    .replace(/\p{Regional_Indicator}{2}/gu, '')
    .replace(/[️‍\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const EMOJI_BMP_DOWNGRADE: ReadonlyMap<string, string> = new Map([
  ['🌙', '☾'], ['🌛', '☾'], ['🌜', '☾'], ['🌚', '☾'], ['🌝', '☾'],
  ['🌞', '☀'], ['🌅', '☀'], ['🌄', '☀'],
  ['😊', '☺'], ['😀', '☺'], ['😃', '☺'], ['😄', '☺'], ['🙂', '☺'], ['😁', '☺'],
  ['😢', '☹'], ['😞', '☹'], ['😔', '☹'], ['🙁', '☹'], ['😟', '☹'],
  ['❤', '♥'], ['💜', '♥'], ['💙', '♥'], ['💚', '♥'], ['💛', '♥'],
  ['🤍', '♥'], ['🖤', '♥'], ['🤎', '♥'], ['💕', '♥'], ['💖', '♥'],
  ['💗', '♥'], ['💓', '♥'], ['💝', '♥'],
  ['📞', '☎'], ['📱', '☎'], ['📲', '☎'],
  ['🏥', '⚕'], ['💊', '⚕'], ['💉', '⚕'], ['🩺', '⚕'], ['🩹', '⚕'],
  ['🌟', '★'], ['🌠', '★'], ['💫', '★'],
  ['👏', '✅'],
  ['📍', '➤'], ['🗺', '➤'],
  ['👨‍⚕️', '⚕'], ['👩‍⚕️', '⚕'], ['🧑‍⚕️', '⚕'],
  ['👍', '✔'], ['👌', '✔'], ['🙌', '✔'], ['🤝', '✔'],
  ['👎', '✖'],
  ['🕐', '⌚'], ['🕑', '⌚'], ['🕒', '⌚'],
  ['🔥', '※'], ['⚠', '⚠'],
  ['👉', '➤'], ['👈', '◀'], ['👇', '▼'], ['☝', '☝'],
  ['↗', '↗'], ['↘', '↘'],
  ['🎉', '✨'], ['🎊', '✨'], ['✨', '✨'],
  ['📅', '✎'], ['📆', '✎'], ['🗓', '✎'], ['📝', '✎'], ['✏', '✎'],
]);

export function downgradeEmoji(text: string): string {
  let out = text;
  for (const [from, to] of EMOJI_BMP_DOWNGRADE) {
    if (out.includes(from)) out = out.replaceAll(from, to);
  }
  out = out.replace(/[\u{10000}-\u{10FFFF}]/gu, '');
  out = out.replace(/[︎️]/g, '');
  return out;
}

const INTER_CHUNK_DELAY_MS = Number(process.env.KOMMO_INTER_CHUNK_MS) || 1600;

/** Teto do Kommo pro `value` de cada handler `show` no continue do Salesbot. */
const WIDGET_SHOW_MAX_LEN = 80;

/**
 * Handler de áudio do Salesbot. Não está na documentação pública — foi lido do
 * "ver código" de um passo de áudio montado no designer do Kommo.
 *
 * O `text` PRECISA ficar vazio: com texto ou botão no mesmo passo, o Kommo
 * manda o arquivo como anexo pra download em vez de mensagem de voz.
 */
function montarHandlerDeAudio(audio: { uuid: string; name: string }): Record<string, unknown> {
  return {
    handler: 'send_message',
    params: {
      type: 'external',
      text: '',
      send_to_all_chat_sources: true,
      recipient: { type: 'all_contacts', way_of_communication: 'over_all' },
      attachments: [{ value: audio.uuid, type: 'audio', is_external: true, name: audio.name }],
      on_error: null,
    },
  };
}

/**
 * Com o teto de 80 o corte às vezes cai depois de uma palavrinha de ligação e o
 * balão termina em "…me contar, em", com o "português" indo pro balão seguinte.
 * Empurra essa órfã pro próximo balão quando couber.
 */
const PALAVRAS_ORFAS = new Set([
  'a', 'o', 'e', 'de', 'da', 'do', 'em', 'no', 'na', 'um', 'uma', 'os', 'as',
  'que', 'com', 'por', 'pra', 'para', 'ao', 'à', 'se', 'ou', 'meu', 'sua',
]);

function evitarOrfas(chunks: string[]): string[] {
  const out = [...chunks];
  for (let i = 0; i < out.length - 1; i++) {
    const palavras = out[i].split(' ');
    const ultima = palavras[palavras.length - 1]?.toLowerCase().replace(/[.,!?;:]$/, '') ?? '';
    if (palavras.length < 2 || !PALAVRAS_ORFAS.has(ultima)) continue;
    const movida = palavras.pop() as string;
    const candidato = `${movida} ${out[i + 1]}`;
    if (candidato.length > WIDGET_SHOW_MAX_LEN) continue;
    out[i] = palavras.join(' ').replace(/[,;]$/, '');
    out[i + 1] = candidato;
  }
  return out.filter((c) => c.trim().length > 0);
}

/**
 * Com o teto de 80 o corte às vezes deixa um resto minúsculo (um emoji, uma
 * palavra) sozinho num balão. Cola esse resto no balão anterior quando couber.
 */
function juntarSobras(chunks: string[]): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    const anterior = out[out.length - 1];
    const cabe = anterior && `${anterior} ${chunk}`.length <= WIDGET_SHOW_MAX_LEN;
    if (chunk.length <= 12 && cabe) {
      out[out.length - 1] = `${anterior} ${chunk}`;
    } else {
      out.push(chunk);
    }
  }
  return out;
}

export function splitIntoChunks(text: string, maxLen: number): string[] {
  const clean = text.trim();
  if (clean.length === 0) return [];
  if (clean.length <= maxLen) return [clean];

  const chunks: string[] = [];
  let remaining = clean;

  while (remaining.length > maxLen) {
    let cut = maxLen;
    const slice = remaining.slice(0, maxLen);

    const candidatos: Array<{ em: number; inclui: number }> = [
      { em: slice.lastIndexOf('\n\n'), inclui: 0 },
      { em: slice.lastIndexOf('\n'), inclui: 0 },
      { em: slice.lastIndexOf('. '), inclui: 1 },
      { em: slice.lastIndexOf('? '), inclui: 1 },
      { em: slice.lastIndexOf('! '), inclui: 1 },
    ];
    const melhor = candidatos
      .filter((c) => c.em > maxLen * 0.12)
      .sort((a, b) => b.em - a.em)[0];

    if (melhor) {
      cut = melhor.em + melhor.inclui;
    } else {
      const lastSpace = slice.lastIndexOf(' ');
      if (lastSpace > maxLen * 0.35) cut = lastSpace;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return colarPedacosSemPalavra(chunks, maxLen);
}

function colarPedacosSemPalavra(chunks: string[], maxLen: number): string[] {
  if (chunks.length < 2) return chunks;
  const out: string[] = [];
  for (const pedaco of chunks) {
    const anterior = out[out.length - 1];
    if (anterior !== undefined && !temPalavra(pedaco)) {
      const junto = `${anterior} ${pedaco}`.trim();
      if (junto.length <= maxLen) out[out.length - 1] = junto;
      continue;
    }
    out.push(pedaco);
  }
  if (out.length > 1 && !temPalavra(out[0])) {
    const junto = `${out[0]} ${out[1]}`.trim();
    out.shift();
    if (junto.length <= maxLen) out[0] = junto;
  }
  return out;
}

const ENTREGA_DEDUP_TTL_MS = 45_000;
const entregasRecentes = new Map<string, number>();
function chaveEntrega(leadId: number, text: string): string {
  return `${leadId}|${text.trim().slice(0, 200)}`;
}
function entregaDuplicada(leadId: number, text: string): boolean {
  const agora = Date.now();
  if (entregasRecentes.size > 500) {
    for (const [k, t] of entregasRecentes) if (agora - t > ENTREGA_DEDUP_TTL_MS) entregasRecentes.delete(k);
  }
  const anterior = entregasRecentes.get(chaveEntrega(leadId, text));
  return !!anterior && agora - anterior < ENTREGA_DEDUP_TTL_MS;
}
function registrarEntrega(leadId: number, text: string): void {
  entregasRecentes.set(chaveEntrega(leadId, text), Date.now());
}

function normalizeEnumLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveEnumId(
  label: string,
  enums: ReadonlyArray<{ id: number; value: string }>,
): number | null {
  if (enums.length === 0) return null;
  const exact = enums.find((e) => e.value === label);
  if (exact) return exact.id;
  const norm = normalizeEnumLabel(label);
  const fuzzy = enums.find((e) => normalizeEnumLabel(e.value) === norm);
  return fuzzy ? fuzzy.id : null;
}

interface KommoCreds {
  subdomain: string;
  accessToken: string;
  salesbotId: number | null;
  replyFieldId: number | null;
  bypassSalesbot: boolean;
  salesbotExecuteEnabled: boolean;
}

function credsFromUnit(
  unit: Pick<
    Unit,
    | 'kommoSubdomain'
    | 'kommoAccessToken'
    | 'kommoSalesbotId'
    | 'kommoReplyFieldId'
    | 'kommoBypassSalesbot'
    | 'kommoSalesbotExecuteEnabled'
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
    salesbotExecuteEnabled: unit.kommoSalesbotExecuteEnabled ?? false,
  };
}

function credsFromEnv(): KommoCreds {
  return {
    subdomain: env.KOMMO_SUBDOMAIN,
    accessToken: env.KOMMO_ACCESS_TOKEN,
    salesbotId: env.KOMMO_SALESBOT_ID ?? null,
    replyFieldId: env.KOMMO_REPLY_FIELD_ID ?? null,
    bypassSalesbot: false,
    salesbotExecuteEnabled: false,
  };
}

const KOMMO_MIN_GAP_MS = 180;
let kommoNextSlot = 0;

async function kommoAcquireSlot(): Promise<void> {
  const now = Date.now();
  const slot = kommoNextSlot > now ? kommoNextSlot : now;
  kommoNextSlot = slot + KOMMO_MIN_GAP_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function kommoBackoff(retryAfterSec?: number): void {
  const ms = Math.min(Math.max((retryAfterSec ?? 5) * 1000, 2000), 60_000);
  const alvo = Date.now() + ms;
  if (alvo > kommoNextSlot) kommoNextSlot = alvo;
}

function buildHttp(creds: KommoCreds): AxiosInstance {
  const http = axios.create({
    baseURL: `https://${creds.subdomain}.kommo.com/api/v4`,
    timeout: 15_000,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      'Accept-Charset': 'utf-8',
    },
    responseType: 'json',
  });

  http.interceptors.request.use(async (config) => {
    await kommoAcquireSlot();
    (config as { metadata?: { start: number } }).metadata = { start: performance.now() };
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
      const status = error.response?.status;
      if (status === 429 || status === 403) {
        const ra = Number((error.response?.data as { retry_after?: number } | undefined)?.retry_after);
        kommoBackoff(Number.isFinite(ra) ? ra : status === 403 ? 30 : undefined);
      }
      logger.warn(
        {
          method: error.config?.method,
          url: error.config?.url,
          status,
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

export class KommoClient {
  constructor(private readonly creds: KommoCreds, private readonly http: AxiosInstance) {}

  private driveUrl: string | null = null;

  get subdomain(): string {
    return this.creds.subdomain;
  }

  /** O host do Drive varia por conta (drive-b, drive-c…), então vem da API. */
  private async getDriveUrl(): Promise<string> {
    if (this.driveUrl) return this.driveUrl;
    const { data } = await this.http.get<{ drive_url?: string }>('/account', {
      params: { with: 'drive_url' },
    });
    if (!data?.drive_url) throw new Error('conta Kommo sem drive_url');
    this.driveUrl = data.drive_url;
    return this.driveUrl;
  }

  /**
   * Sobe um arquivo pro Drive do Kommo e devolve o uuid, que é o que o handler
   * `send_message` espera em `attachments[].value`.
   *
   * São dois passos: abre uma sessão de upload (autenticada) e joga os bytes na
   * `upload_url` que ela devolve — essa segunda chamada NÃO leva Authorization,
   * o token já vai embutido na própria URL.
   */
  async uploadToDrive(bytes: Buffer, fileName: string, contentType: string): Promise<string> {
    const t0 = performance.now();
    try {
      const driveUrl = await this.getDriveUrl();
      const { data: session } = await axios.post<{ upload_url: string }>(
        `${driveUrl}/v1.0/sessions`,
        { file_name: fileName, file_size: bytes.length, content_type: contentType },
        {
          headers: { Authorization: `Bearer ${this.creds.accessToken}` },
          timeout: 20_000,
        },
      );
      const { data: file } = await axios.post<{ uuid?: string }>(session.upload_url, bytes, {
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 60_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      if (!file?.uuid) throw new Error('upload sem uuid na resposta');
      logger.info(
        { fileName, bytes: bytes.length, uuid: file.uuid, ms: Math.round(performance.now() - t0) },
        'kommo drive: arquivo enviado',
      );
      return file.uuid;
    } catch (err) {
      wrapAxiosError(err, `uploadToDrive(${fileName})`);
    }
  }

  async getContactPhone(contactId: number): Promise<string | null> {
    try {
      const { data } = await this.http.get<{
        custom_fields_values?: Array<{
          field_code?: string;
          values?: Array<{ value?: string }>;
        }>;
      }>(`/contacts/${contactId}`);
      const campo = data?.custom_fields_values?.find((f) => f.field_code === 'PHONE');
      const v = campo?.values?.[0]?.value;
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
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

  async setLeadCustomFieldValue(
    leadId: number,
    fieldId: number,
    fieldType: KommoFieldType,
    value: string | number | string[],
    enums: ReadonlyArray<{ id: number; value: string }> = [],
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
      if (typeof value !== 'string') {
        throw new Error(`field ${fieldId} (${fieldType}) requer string (label da opção)`);
      }
      const enumId = resolveEnumId(value, enums);
      values = enumId != null ? [{ enum_id: enumId }] : [{ value: downgradeEmoji(value) }];
    } else if (fieldType === 'multiselect') {
      const arr = Array.isArray(value) ? value : [value];
      values = arr.map((v) => {
        const label = String(v);
        const enumId = resolveEnumId(label, enums);
        return enumId != null ? { enum_id: enumId } : { value: downgradeEmoji(label) };
      });
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

  async addTag({ leadId, tag, tags }: AddTagParams): Promise<void> {
    const all = [
      ...(tag ? [tag] : []),
      ...(Array.isArray(tags) ? tags : []),
    ]
      .map((t) => t?.trim())
      .filter((t): t is string => !!t);
    if (all.length === 0) return;
    const seen = new Set<string>();
    const unique = all.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
    try {
      await this.http.patch(`/leads/${leadId}`, {
        tags_to_add: unique.map((name) => ({ name })),
      });
    } catch (err) {
      wrapAxiosError(err, `addTag(${leadId}, [${unique.join(', ')}])`);
    }
  }

  async removeTag(leadId: number, tag: string): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, {
        tags_to_delete: [{ name: tag }],
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

  async setLeadResponsible(leadId: number, userId: number): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, { responsible_user_id: userId });
    } catch (err) {
      wrapAxiosError(err, `setLeadResponsible(${leadId}, user=${userId})`);
    }
  }

  async setLeadPrice(leadId: number, price: number): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, { price });
    } catch (err) {
      wrapAxiosError(err, `setLeadPrice(${leadId}, price=${price})`);
    }
  }

  async setLeadStatus(
    leadId: number,
    options: { won: boolean; lossReasonId?: number },
  ): Promise<void> {
    const statusId = options.won ? 142 : 143;
    const body: Record<string, unknown> = { status_id: statusId };
    if (!options.won && options.lossReasonId) body.loss_reason_id = options.lossReasonId;
    try {
      await this.http.patch(`/leads/${leadId}`, body);
    } catch (err) {
      wrapAxiosError(err, `setLeadStatus(${leadId}, won=${options.won})`);
    }
  }

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

  async updateLeadName(leadId: number, name: string): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, { name });
    } catch (err) {
      wrapAxiosError(err, `updateLeadName(${leadId}, ${name})`);
    }
  }

  async updateLeadTitleWithDate(
    leadId: number,
    nome: string,
  ): Promise<{ previous: string | null; desired: string; changed: boolean }> {
    const lead = await this.getLead(leadId);
    const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const dateBR = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(createdAtMs));
    const desired = `${nome.trim()} ${dateBR}`;
    const previous = lead.name ?? null;
    if (previous === desired) {
      return { previous, desired, changed: false };
    }
    await this.updateLeadName(leadId, desired);
    return { previous, desired, changed: true };
  }

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

  async listLeadsDesde(desdeEpochSeg: number, limite = 100): Promise<KommoLead[]> {
    try {
      const { data } = await this.http.get<{ _embedded?: { leads?: KommoLead[] } }>('/leads', {
        params: {
          limit: Math.min(limite, 250),
          'filter[created_at][from]': desdeEpochSeg,
          order: { created_at: 'desc' },
        },
      });
      return data?._embedded?.leads ?? [];
    } catch (err) {
      wrapAxiosError(err, 'listLeadsDesde');
      return [];
    }
  }

  async listLeadsAtualizadosDesde(
    desdeEpochSeg: number,
    limite = 250,
  ): Promise<Array<{ id: number; status_id?: number; loss_reason_id?: number | null }>> {
    try {
      const { data } = await this.http.get<{
        _embedded?: { leads?: Array<{ id: number; status_id?: number; loss_reason_id?: number | null }> };
      }>('/leads', {
        params: {
          limit: Math.min(limite, 250),
          'filter[updated_at][from]': desdeEpochSeg,
          order: { updated_at: 'desc' },
        },
      });
      return data?._embedded?.leads ?? [];
    } catch (err) {
      wrapAxiosError(err, 'listLeadsAtualizadosDesde');
      return [];
    }
  }

  async listLeadsAtualizadosComCampos(desdeEpochSeg: number, limite = 250): Promise<KommoLead[]> {
    try {
      const { data } = await this.http.get<{ _embedded?: { leads?: KommoLead[] } }>('/leads', {
        params: {
          limit: Math.min(limite, 250),
          'filter[updated_at][from]': desdeEpochSeg,
          order: { updated_at: 'desc' },
        },
      });
      return data?._embedded?.leads ?? [];
    } catch (err) {
      wrapAxiosError(err, 'listLeadsAtualizadosComCampos');
      return [];
    }
  }

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

  async setLeadFieldFlag(leadId: number, fieldId: number, value: boolean): Promise<void> {
    try {
      await this.http.patch(`/leads/${leadId}`, {
        custom_fields_values: [{ field_id: fieldId, values: [{ value }] }],
      });
    } catch (err) {
      wrapAxiosError(err, `setLeadFieldFlag(${leadId}, ${fieldId}, ${value})`);
    }
  }

  async getCustomField(fieldId: number): Promise<KommoCustomField> {
    try {
      const { data } = await this.http.get<KommoCustomField>(`/leads/custom_fields/${fieldId}`);
      return data;
    } catch (err) {
      wrapAxiosError(err, `getCustomField(${fieldId})`);
    }
  }

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

  async getSalesbot(salesbotId: number): Promise<KommoSalesbot> {
    try {
      const { data } = await this.http.get<KommoSalesbot>(`/salesbot/${salesbotId}`);
      return data;
    } catch (err) {
      wrapAxiosError(err, `getSalesbot(${salesbotId})`);
    }
  }

  async triggerSalesbot(
    salesbotId: number,
    leadId: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.http.post(`/bots/${salesbotId}/run`, {
        entity_id: leadId,
        entity_type: 'leads',
      });
      return { ok: true };
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `${status ?? '?'}: ${msg}` };
    }
  }

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
    if (entregaDuplicada(leadId, text)) {
      logger.warn({ leadId, salesbotId }, 'runSalesbot: MESMO texto já enviado a este lead há <45s — PULANDO (anti-duplicata)');
      await recorder?.step({
        kind: 'KOMMO_ACTION',
        title: '🛑 Anti-duplicata: mesmo texto já enviado há <45s — envio pulado',
        payload: { leadId, salesbotId, mode: 'skipped_duplicate' },
      });
      return { via: 'skipped_duplicate' };
    }

    const t0Patch = performance.now();
    try {
      const safeText = downgradeEmoji(text);
      const wasDowngraded = safeText !== text;
      const sentBytes = Buffer.byteLength(safeText, 'utf8');
      const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(safeText);
      await this.http.patch(`/leads/${leadId}`, {
        custom_fields_values: [{ field_id: replyFieldId, values: [{ value: safeText }] }],
      });
      registrarEntrega(leadId, text);
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

    if (this.creds.salesbotExecuteEnabled) {
      const t0Run = performance.now();
      try {
        await this.http.post(`/bots/${salesbotId}/run`, {
          entity_id: leadId,
          entity_type: 'leads',
        });
        const runMs = Math.round(performance.now() - t0Run);
        logger.info(
          { leadId, salesbotId, route: 'bots_run' },
          'runSalesbot: POST /bots/{id}/run (modo /execute) enviado',
        );
        await recorder?.step({
          kind: 'KOMMO_ACTION',
          title: `🤖 /execute: POST /bots/${salesbotId}/run (entity_type=leads)`,
          payload: {
            leadId,
            salesbotId,
            triggeredBy: 'execute_api',
            endpoint: `/api/v4/bots/${salesbotId}/run`,
            nota: 'Modo /execute: o gatilho de "campo mudou" do Digital Pipeline DEVE estar DESLIGADO nesta unidade pra não duplicar.',
          },
          latencyMs: runMs,
        });
        return { runApi: 'execute', triggeredBy: 'execute_api', salesbotId };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        await recorder?.step({
          kind: 'ERROR',
          title: `❌ /execute POST /bots/${salesbotId}/run falhou (${status ?? '?'}): ${msg}`,
          payload: { leadId, salesbotId, status, error: msg },
        });
        wrapAxiosError(err, `runSalesbot:execute(${leadId}, bot=${salesbotId})`);
      }
    }

    await recorder?.step({
      kind: 'KOMMO_ACTION',
      title: '✅ PATCH-only: Digital Pipeline aciona o Salesbot ao mudar o campo',
      payload: {
        leadId,
        salesbotId,
        triggeredBy: 'field_change',
        nota: 'O envio depende do gatilho "Digital Pipeline → Quando o campo Resposta IA mudar → rodar Salesbot" configurado no Kommo desta conta.',
      },
    });
    return { runApi: 'patch_only', triggeredBy: 'field_change', salesbotId };
  }

  async sendChatReply({
    leadId,
    text,
    chatId,
    talkId,
    contactId,
    recorder,
  }: SendChatReplyParams): Promise<SendChatReplyResult> {
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
            await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
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
            await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
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

  /**
   * Lança um Salesbot num lead. Usado no modo widget porque o Kommo só oferece
   * gatilho de "chat iniciado" — que não dispara da 2ª mensagem em diante. Aqui
   * quem decide a hora de rodar somos nós, a cada mensagem recebida.
   */
  async runBot(botId: number, entityId: number, entityType: 'leads' | 'contacts'): Promise<void> {
    const t0 = performance.now();
    try {
      await this.http.post(`/bots/${botId}/run`, { entity_id: entityId, entity_type: entityType });
      logger.info(
        { botId, entityId, entityType, ms: Math.round(performance.now() - t0) },
        'widget: Salesbot lançado por API',
      );
    } catch (err) {
      wrapAxiosError(err, `runBot(${botId}, ${entityType}=${entityId})`);
    }
  }

  /**
   * Descobre o contato do chat de um lead.
   *
   * Importa MUITO no modo widget: lançar o bot com `entity_type: leads` faz o
   * Kommo rodar em contexto de MARKETINGBOT — o `show` é aceito com 200 e
   * descartado em silêncio, porque não há conversa. Com o contato, o bot roda
   * como SALESBOT e a resposta chega no WhatsApp.
   */
  async getFirstContactId(leadId: number): Promise<number | null> {
    try {
      const lead = await this.getLead(leadId);
      const contatos = (lead as { _embedded?: { contacts?: Array<{ id?: number }> } })._embedded?.contacts;
      const id = contatos?.find((c) => typeof c.id === 'number')?.id;
      return typeof id === 'number' ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * Encerra o bot sem falar nada com o paciente.
   *
   * Precisa existir porque há caminhos em que o agente decide NÃO responder (IA
   * pausada por humano, fora do escopo, handoff). Sem isso o bot fica pendurado
   * pra sempre naquele contato — e como só roda um bot por contato, a próxima
   * mensagem dele não dispara nada. As sessões ativas só crescem.
   *
   * `execute_handlers` vazio não serve (400 TooFew), então mandamos `stop`. Se
   * o Kommo recusar esse handler também, engolimos o erro: pendurado é ruim,
   * mas quebrar o fluxo de quem NÃO ia receber resposta seria pior.
   */
  async finalizarSalesbotWidget(returnUrl: string): Promise<boolean> {
    try {
      await this.http.post(returnUrl, {
        data: { status: 'success' },
        execute_handlers: [{ handler: 'stop', params: {} }],
      });
      logger.info({ returnUrl }, 'widget: bot encerrado sem resposta (IA não respondeu)');
      return true;
    } catch (err) {
      const detalhe = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data)?.slice(0, 200)
        : String(err);
      logger.warn({ returnUrl, detalhe }, 'widget: não consegui encerrar o bot — vai expirar sozinho');
      return false;
    }
  }

  async continueSalesbotWidget(
    returnUrl: string,
    args: {
      text: string;
      audio?: { uuid: string; name: string } | null;
      data?: Record<string, unknown>;
      recorder?: KommoStepRecorder;
    },
  ): Promise<{ via: 'widget_continue'; chunks: number; detail: unknown }> {
    const t0 = performance.now();
    // O Kommo valida cada balão do `show` em 80 chars — passar disso derruba a
    // chamada inteira com 400 TooLong (execute_handlers.params.value) e o
    // paciente não recebe NADA. Não é limite nosso, é do lado deles.
    const chunks = evitarOrfas(juntarSobras(splitIntoChunks(args.text, WIDGET_SHOW_MAX_LEN)));
    // Sem `goto` no fim: `{type:'finish'}` sem `step` é inválido pro Kommo, e o
    // bot termina sozinho quando acaba o passo.
    // Blindagem: `execute_handlers` vazio é 400 TooFew e deixa o bot pendurado
    // (e bot pendurado bloqueia a próxima mensagem, porque só roda um por
    // contato). Se não sobrou texto, manda ao menos uma linha.
    const seguros = chunks.length > 0 ? chunks : ['Pode me contar um pouco mais? 🙏'];
    const handlersDeTexto = seguros.map((value) => ({
      handler: 'show',
      params: { type: 'text', value },
    }));
    const data = args.data ?? { status: 'success' };

    // Tenta áudio primeiro quando houver, mas NUNCA deixa o paciente sem
    // resposta: se o Kommo recusar o handler, reenvia em texto na hora.
    if (args.audio) {
      try {
        const resp = await this.http.post(returnUrl, {
          data,
          execute_handlers: [montarHandlerDeAudio(args.audio)],
        });
        const ms = Math.round(performance.now() - t0);
        logger.info({ returnUrl, uuid: args.audio.uuid }, 'widget continue: resposta entregue em ÁUDIO');
        await args.recorder?.step({
          kind: 'KOMMO_ACTION',
          title: '🔊 Widget continue: resposta entregue como mensagem de voz',
          payload: { returnUrl, uuid: args.audio.uuid, sentText: args.text },
          latencyMs: ms,
        });
        return { via: 'widget_continue', chunks: 1, detail: resp.data };
      } catch (err) {
        const detalhe = axios.isAxiosError(err)
          ? JSON.stringify(err.response?.data)?.slice(0, 200)
          : String(err);
        logger.warn({ returnUrl, detalhe }, 'widget continue: áudio recusado pelo Kommo — caindo pra texto');
        await args.recorder?.step({
          kind: 'ERROR',
          title: '🔊 Kommo recusou o áudio — reenviando em texto',
          payload: { returnUrl, detalhe },
        });
      }
    }

    try {
      const resp = await this.http.post(returnUrl, { data, execute_handlers: handlersDeTexto });
      const ms = Math.round(performance.now() - t0);
      logger.info(
        { returnUrl, chunks: seguros.length, semTextoOriginal: chunks.length === 0 },
        'widget continue: Salesbot retomado via return_url',
      );
      await args.recorder?.step({
        kind: 'KOMMO_ACTION',
        title:
          chunks.length === 0
            ? '📤 Widget continue: bot finalizado sem mensagem'
            : `📤 Widget continue: ${chunks.length} balão(ões) via execute_handlers [show]`,
        payload: { returnUrl, chunks: chunks.length, sentText: args.text },
        latencyMs: ms,
      });
      return { via: 'widget_continue', chunks: chunks.length, detail: resp.data };
    } catch (err) {
      wrapAxiosError(err, `continueSalesbotWidget(${returnUrl})`);
    }
  }
}

export function createKommoClient(
  unit: Pick<
    Unit,
    | 'kommoSubdomain'
    | 'kommoAccessToken'
    | 'kommoSalesbotId'
    | 'kommoReplyFieldId'
    | 'kommoBypassSalesbot'
    | 'kommoSalesbotExecuteEnabled'
  >,
): KommoClient {
  const creds = credsFromUnit(unit);
  return new KommoClient(creds, buildHttp(creds));
}

export async function isLeadPaused(
  unit: Pick<
    Unit,
    | 'kommoSubdomain'
    | 'kommoAccessToken'
    | 'kommoSalesbotId'
    | 'kommoReplyFieldId'
    | 'kommoPausedFieldId'
    | 'kommoBypassSalesbot'
    | 'kommoSalesbotExecuteEnabled'
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

let envClient: KommoClient | null = null;

export function getEnvKommoClient(): KommoClient {
  if (!envClient) {
    const creds = credsFromEnv();
    envClient = new KommoClient(creds, buildHttp(creds));
  }
  return envClient;
}

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
