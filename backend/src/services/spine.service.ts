import { randomUUID } from 'node:crypto';
import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';

const DEFAULT_TZ = 'America/Sao_Paulo';

const MAX_PAGES = 40;

export const SPINE_STATUS = {
  AGENDADO: 37,
  CONFIRMADO: 38,
  NAO_COMPARECEU: 40,
  REMARCADO: 41,
  ATENDIDO: 42,
  DESMARCADO: 57,
} as const;

const FREE_STATUS: number[] = [SPINE_STATUS.DESMARCADO];

function ocupa(idStatus: number | null): boolean {
  if (idStatus === null) return true;
  return !FREE_STATUS.includes(idStatus);
}

export interface SpineRawSchedule {
  idSchedule?: number;
  idTreatment?: number;
  clientName?: string;
  dateAttendance?: string;
  idCategory?: number;
  categoryName?: string;
  physicalTherapist?: string;
  idStatus?: number;
  statusName?: string;
  modified?: string;
  modifiedBy?: string;
}

interface SpineEnvelope {
  status?: string;
  data?: {
    data?: SpineRawSchedule[];
    total?: number;
    page?: number;
    rowsPerPage?: number;
    totalPages?: number;
  };
}

export interface SpineSchedule {
  idSchedule: number | null;
  idTreatment: number | null;
  idStatus: number | null;
  statusName: string | null;
  clientName: string | null;
  categoryName: string | null;
  physicalTherapist: string | null;
  dateAttendanceUtc: string | null;
  dateAttendanceLocal: string | null;
  dayLocal: string | null;
  timeLocal: string | null;
  isBusy: boolean;
  requiresManualValidation: boolean;
}

export interface SpineResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

export type SpineUnit = Pick<Unit, 'spineBaseUrl' | 'spineToken' | 'spineTimezone'>;

function client(unit: SpineUnit): AxiosInstance | null {
  if (!unit.spineToken) return null;
  const http = axios.create({
    baseURL: (unit.spineBaseUrl || '').replace(/\/$/, ''),
    timeout: 30_000,
    headers: {
      Authorization: `Bearer ${unit.spineToken}`,
      'Content-Type': 'application/json',
    },
  });
  // Guia da franquia §12: registrar request_id e retentar falhas transitórias.
  http.interceptors.request.use((cfg) => {
    cfg.headers.set('X-Request-Id', randomUUID());
    return cfg;
  });
  http.interceptors.response.use(undefined, async (err: AxiosError) => {
    const cfg = err.config as (InternalAxiosRequestConfig & { __retentou?: boolean }) | undefined;
    const idempotente = !!cfg && (cfg.method?.toUpperCase() === 'GET' || /\/search$/.test(cfg.url ?? ''));
    const transitorio = !!err.response && err.response.status >= 500;
    if (cfg && idempotente && transitorio && !cfg.__retentou) {
      cfg.__retentou = true;
      await new Promise((r) => setTimeout(r, 400));
      return http.request(cfg);
    }
    throw err;
  });
  return http;
}

function describe(err: unknown): { error: string; status?: number; requestId?: string } {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const requestId = String(err.config?.headers?.['X-Request-Id'] ?? '') || undefined;
    const body = err.response?.data as { error?: string; errors?: string[] } | undefined;
    const msg = body?.errors?.join('; ') || body?.error || err.message;
    const humano =
      status === 401
        ? 'token inválido, ausente ou expirado'
        : status === 403
          ? 'token sem permissão para este recurso'
          : status === 404
            ? 'endpoint não encontrado'
            : msg;
    return { error: `${status ?? '?'}: ${humano}`, status, requestId };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

export function instanteNoFuso(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const hora = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hora}:${p.minute}:${p.second}`;
}

function offsetMs(d: Date, tz: string): number {
  return Date.parse(`${instanteNoFuso(d, tz)}Z`) - d.getTime();
}

export function localParaUtcIso(localIso: string, tz: string): string | null {
  const palpite = Date.parse(`${localIso}Z`);
  if (Number.isNaN(palpite)) return null;
  let ms = palpite - offsetMs(new Date(palpite), tz);
  ms = palpite - offsetMs(new Date(ms), tz);
  return new Date(ms).toISOString();
}

function toClinicTime(
  utcIso: string | undefined | null,
  tz: string,
): { local: string | null; day: string | null; time: string | null } {
  if (!utcIso) return { local: null, day: null, time: null };
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return { local: null, day: null, time: null };
  const local = instanteNoFuso(d, tz);
  return { local, day: local.slice(0, 10), time: local.slice(11, 16) };
}

function normalize(raw: SpineRawSchedule, tz: string): SpineSchedule {
  const { local, day, time } = toClinicTime(raw.dateAttendance, tz);
  const idStatus = typeof raw.idStatus === 'number' ? raw.idStatus : null;
  return {
    idSchedule: raw.idSchedule ?? null,
    idTreatment: raw.idTreatment ?? null,
    idStatus,
    statusName: raw.statusName ?? null,
    clientName: raw.clientName ?? null,
    categoryName: raw.categoryName ?? null,
    physicalTherapist: raw.physicalTherapist ?? null,
    dateAttendanceUtc: raw.dateAttendance ?? null,
    dateAttendanceLocal: local,
    dayLocal: day,
    timeLocal: time,
    isBusy: ocupa(idStatus),
    requiresManualValidation: idStatus === SPINE_STATUS.DESMARCADO,
  };
}

function somarDias(yyyymmdd: string, dias: number): string {
  const t = Date.parse(`${yyyymmdd}T00:00:00Z`);
  if (Number.isNaN(t)) return yyyymmdd;
  return new Date(t + dias * 86_400_000).toISOString().slice(0, 10);
}

export async function searchSchedules(
  unit: SpineUnit,
  params: { initialDate: string; endDate: string; rowsPerPage?: number },
): Promise<SpineResult<{ schedules: SpineSchedule[]; pages: number; total: number }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };

  const rowsPerPage = Math.min(params.rowsPerPage ?? 50, 100);
  const fimExclusivo = somarDias(params.endDate, 1);
  const todos: SpineSchedule[] = [];
  let page = 1;
  let totalPages = 1;
  let total = 0;

  try {
    do {
      const { data } = await http.post<SpineEnvelope>('/api/schedules/search', {
        initialDate: params.initialDate,
        endDate: fimExclusivo,
        pagination: { page, rowsPerPage },
      });

      const corpo = data?.data;
      const tz = unit.spineTimezone || DEFAULT_TZ;
      for (const raw of corpo?.data ?? []) todos.push(normalize(raw, tz));
      totalPages = Math.max(1, Number(corpo?.totalPages) || 1);
      total = Number(corpo?.total) || todos.length;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    if (totalPages > MAX_PAGES) {
      logger.warn(
        { totalPages, lidas: MAX_PAGES, unit: unit.spineBaseUrl },
        'spine: busca truncada no teto de páginas',
      );
    }

    const dentro = todos.filter(
      (s) => s.dayLocal !== null && s.dayLocal >= params.initialDate && s.dayLocal <= params.endDate,
    );

    return {
      ok: true,
      data: { schedules: dentro, pages: Math.min(totalPages, MAX_PAGES), total: dentro.length },
    };
  } catch (err) {
    const d = describe(err);
    logger.warn({ erro: d.error, requestId: d.requestId, ...params }, 'spine: falha ao buscar agendamentos');
    return { ok: false, ...d };
  }
}

export interface SpineCreateSchedule {
  idClient: number;
  dateAttendanceLocal: string;
  idCategory: number;
  idStaff?: number;
}

export async function createSchedule(
  unit: SpineUnit,
  input: SpineCreateSchedule,
): Promise<SpineResult<{ idSchedule?: number }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };

  const local = input.dateAttendanceLocal.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(local)) {
    return { ok: false, error: 'dateAttendanceLocal inválida (use AAAA-MM-DDTHH:mm:ss, sem fuso)' };
  }
  const dateAttendance = local.length === 16 ? `${local}:00` : local;

  try {
    const { data } = await http.post<{ idSchedule?: number; data?: { idSchedule?: number } }>('/api/schedules', {
      idClient: input.idClient,
      dateAttendance,
      idCategory: input.idCategory,
      ...(input.idStaff !== undefined ? { idStaff: input.idStaff } : {}),
    });
    return { ok: true, data: { idSchedule: data?.data?.idSchedule ?? data?.idSchedule } };
  } catch (err) {
    const d = describe(err);
    logger.warn({ erro: d.error, requestId: d.requestId, input }, 'spine: falha ao criar agendamento');
    return { ok: false, ...d };
  }
}

export interface SpineClient {
  idClient: number | null;
  name: string | null;
  whatsapp: string | null;
}

export async function searchClients(
  unit: SpineUnit,
  name: string,
): Promise<SpineResult<{ clients: SpineClient[] }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };
  try {
    const { data } = await http.post<{
      data?: { data?: Array<{ idClient?: number; name?: string; whatsapp?: string }> };
    }>('/api/clients/search', { name, pagination: { page: 1, rowsPerPage: 20 } });
    const clients = (data?.data?.data ?? []).map((c) => ({
      idClient: c.idClient ?? null,
      name: c.name ?? null,
      whatsapp: c.whatsapp ?? null,
    }));
    return { ok: true, data: { clients } };
  } catch (err) {
    return { ok: false, ...describe(err) };
  }
}

export const SPINE_LEAD_CATEGORY_CONTATO = 3;

const MAPA_ORIGEM: Record<string, number> = {
  'meta-instagram': 23,
  'org-instagram': 23,
  instagram: 23,
  'meta-facebook': 22,
  'org-facebook': 22,
  facebook: 22,
  'org-whatsapp': 20,
  whatsapp: 20,
  'site oficial - franquia': 7,
  site: 7,
  indicação: 3,
  indicacao: 3,
  google: 1,
  tiktok: 10000,
  'tik tok': 10000,
};

export function resolverIdSource(origemKommo: string | null | undefined, padrao: number): number {
  if (!origemKommo) return padrao;
  const chave = origemKommo.trim().toLowerCase();
  return MAPA_ORIGEM[chave] ?? padrao;
}

export function nomeDaOrigem(id: number): string {
  const rotulos: Record<number, string> = {
    1: 'Google',
    3: 'Indicação',
    7: 'Site oficial',
    20: 'WhatsApp',
    22: 'Facebook',
    23: 'Instagram',
    10000: 'TikTok',
  };
  return rotulos[id] ?? `origem #${id}`;
}

export interface SpineCreateLead {
  name: string;
  whatsapp?: string | null;
  email?: string | null;
  description: string;
  idSource: number;
  addressCity?: string | null;
  addressUf?: string | null;
}

export async function createLead(
  unit: SpineUnit,
  input: SpineCreateLead,
): Promise<SpineResult<{ idLead?: number }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };

  const corpo: Record<string, unknown> = {
    name: input.name.trim().slice(0, 255),
    description: (input.description || '').trim().slice(0, 1000) || '-',
    idSource: input.idSource,
    idLeadsCategory: SPINE_LEAD_CATEGORY_CONTATO,
    idCategory: SPINE_LEAD_CATEGORY_CONTATO,
  };
  if (input.whatsapp) corpo.whatsapp = normalizarWhatsapp(input.whatsapp);
  if (input.email) corpo.email = input.email.trim().slice(0, 255);
  if (input.addressCity) corpo.addressCity = input.addressCity.trim().toUpperCase().slice(0, 100);
  if (input.addressUf) corpo.addressUf = input.addressUf.trim().toUpperCase().slice(0, 2);

  try {
    const { data } = await http.post<{ idLead?: number; data?: { idLead?: number } }>(
      '/api/leads',
      corpo,
    );
    return { ok: true, data: { idLead: data?.data?.idLead ?? data?.idLead } };
  } catch (err) {
    const d = describe(err);
    logger.warn({ erro: d.error, nome: input.name }, 'spine: falha ao criar lead');
    return { ok: false, ...d };
  }
}

export interface SpineCreateClient {
  name: string;
  whatsapp?: string | null;
  email?: string | null;
  idSource: number;
  idLead?: number | null;
  addressCity?: string | null;
  addressUf?: string | null;
}

export async function createClient(
  unit: SpineUnit,
  input: SpineCreateClient,
): Promise<SpineResult<{ idClient?: number }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };

  const fone = input.whatsapp ? normalizarWhatsapp(input.whatsapp) : '';
  if (!fone && !input.email) {
    return { ok: false, error: 'paciente sem telefone nem e-mail' };
  }

  const corpo: Record<string, unknown> = {
    name: input.name.trim().slice(0, 255),
    idSource: input.idSource,
  };
  if (fone) corpo.whatsapp = fone;
  if (input.email) corpo.email = input.email.trim().slice(0, 255);
  if (input.idLead) corpo.idLead = input.idLead;
  if (input.addressCity) corpo.addressCity = input.addressCity.trim().toUpperCase().slice(0, 100);
  if (input.addressUf) corpo.addressUf = input.addressUf.trim().toUpperCase().slice(0, 2);

  try {
    const { data } = await http.post<{ idClient?: number; data?: { idClient?: number } }>(
      '/api/clients',
      corpo,
    );
    return { ok: true, data: { idClient: data?.data?.idClient ?? data?.idClient } };
  } catch (err) {
    const d = describe(err);
    logger.warn({ erro: d.error, nome: input.name }, 'spine: falha ao criar paciente');
    return { ok: false, ...d };
  }
}

export interface SpineClientDetail {
  idClient: number | null;
  name: string | null;
  whatsapp: string | null;
  schedules: SpineSchedule[];
}

interface SpineRawClientDetail {
  idClient?: number;
  name?: string;
  whatsapp?: string;
  schedules?: Array<{
    idSchedule?: number;
    dateAttendance?: string;
    category?: string;
    physicalTherapist?: string;
    idStatus?: number;
    statusName?: string;
  }>;
}

export async function getClient(
  unit: SpineUnit,
  idClient: number,
): Promise<SpineResult<{ client: SpineClientDetail | null }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };
  const tz = unit.spineTimezone || DEFAULT_TZ;
  try {
    const { data } = await http.get<{
      success?: boolean;
      data?: { data?: SpineRawClientDetail } | SpineRawClientDetail | null;
    }>(`/api/clients/${idClient}`);

    const envelope = data?.data as { data?: SpineRawClientDetail } | SpineRawClientDetail | null;
    const cru =
      (envelope && typeof envelope === 'object' && 'data' in envelope
        ? (envelope as { data?: SpineRawClientDetail }).data
        : (envelope as SpineRawClientDetail | null)) ?? null;

    if (!cru || cru.idClient === undefined) return { ok: true, data: { client: null } };

    return {
      ok: true,
      data: {
        client: {
          idClient: cru.idClient ?? null,
          name: cru.name ?? null,
          whatsapp: cru.whatsapp ?? null,
          schedules: (cru.schedules ?? []).map((s) =>
            normalize(
              {
                idSchedule: s.idSchedule,
                dateAttendance: s.dateAttendance,
                idStatus: s.idStatus,
                statusName: s.statusName,
                physicalTherapist: s.physicalTherapist,
                categoryName: s.category,
              },
              tz,
            ),
          ),
        },
      },
    };
  } catch (err) {
    const d = describe(err);
    if (d.status === 404) return { ok: true, data: { client: null } };
    logger.warn({ erro: d.error, idClient }, 'spine: falha ao consultar paciente por id');
    return { ok: false, ...d };
  }
}

export interface SpineConvertLead {
  idLead: number;
  name: string;
  idSource: number;
  whatsapp?: string | null;
  email?: string | null;
}

export async function convertLead(
  unit: SpineUnit,
  input: SpineConvertLead,
): Promise<SpineResult<{ idClient?: number }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };

  const fone = input.whatsapp ? normalizarWhatsapp(input.whatsapp) : '';
  if (!fone && !input.email) {
    return { ok: false, error: 'conversão exige WhatsApp ou e-mail' };
  }

  try {
    const { data } = await http.post<{ idClient?: number; data?: { idClient?: number } }>(
      '/api/leads/convert',
      {
        idLead: input.idLead,
        name: input.name.trim().slice(0, 255),
        idSource: input.idSource,
        ...(fone ? { whatsapp: fone } : {}),
        ...(input.email ? { email: input.email.trim().slice(0, 255) } : {}),
      },
    );
    return { ok: true, data: { idClient: data?.data?.idClient ?? data?.idClient } };
  } catch (err) {
    const d = describe(err);
    logger.warn(
      { erro: d.error, idLead: input.idLead, nome: input.name },
      'spine: falha ao converter lead em paciente',
    );
    return { ok: false, ...d };
  }
}

export async function cancelSchedule(
  unit: SpineUnit,
  idSchedule: number,
): Promise<SpineResult<{ idSchedule?: number }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };
  try {
    const { data } = await http.delete<{ idSchedule?: number; data?: { idSchedule?: number } }>(
      '/api/schedules',
      { data: { idSchedule } },
    );
    return { ok: true, data: { idSchedule: data?.data?.idSchedule ?? data?.idSchedule } };
  } catch (err) {
    const d = describe(err);
    logger.warn({ erro: d.error, idSchedule }, 'spine: falha ao cancelar agendamento');
    return { ok: false, ...d };
  }
}

export async function confirmSchedule(
  unit: SpineUnit,
  idSchedule: number,
): Promise<SpineResult<{ idSchedule?: number }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };
  try {
    const { data } = await http.patch<{ idSchedule?: number; data?: { idSchedule?: number } }>(
      '/api/schedules/confirm',
      { idSchedule },
    );
    return { ok: true, data: { idSchedule: data?.data?.idSchedule ?? data?.idSchedule ?? idSchedule } };
  } catch (err) {
    const d = describe(err);
    logger.warn({ erro: d.error, idSchedule }, 'spine: falha ao confirmar presença');
    return { ok: false, ...d };
  }
}

export interface SpineLeadSource {
  sourceName: string;
  total: number;
}

const BI_MAX_DIAS = 100;

const biCache = new Map<string, { em: number; valor: { sources: SpineLeadSource[]; total: number } }>();
const BI_TTL_MS = 60 * 60_000;

export async function biLeadsSources(
  unit: SpineUnit & { id?: string },
  params: { initialDate: string; endDate: string },
): Promise<SpineResult<{ sources: SpineLeadSource[]; total: number; cache: boolean }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };

  const dias =
    (Date.parse(`${params.endDate}T00:00:00Z`) - Date.parse(`${params.initialDate}T00:00:00Z`)) /
    86_400_000;
  if (!Number.isFinite(dias) || dias < 0) {
    return { ok: false, error: 'intervalo inválido (use AAAA-MM-DD, endDate >= initialDate)' };
  }
  if (dias > BI_MAX_DIAS) {
    return { ok: false, error: `intervalo maior que ${BI_MAX_DIAS} dias — a API da franquia recusa` };
  }

  const k = `${unit.id ?? unit.spineToken?.slice(-8)}:${params.initialDate}:${params.endDate}`;
  const hit = biCache.get(k);
  if (hit && Date.now() - hit.em < BI_TTL_MS) {
    return { ok: true, data: { ...hit.valor, cache: true } };
  }

  try {
    const { data } = await http.post<{
      data?: { sources?: Array<{ sourceName?: string; total?: number }>; total?: number };
    }>('/api/bi/leads/sources', { initialDate: params.initialDate, endDate: params.endDate });

    const sources = (data?.data?.sources ?? [])
      .map((s) => ({ sourceName: s.sourceName ?? '(sem origem)', total: s.total ?? 0 }))
      .sort((a, b) => b.total - a.total);
    const valor = { sources, total: data?.data?.total ?? sources.reduce((n, s) => n + s.total, 0) };

    biCache.set(k, { em: Date.now(), valor });
    return { ok: true, data: { ...valor, cache: false } };
  } catch (err) {
    const d = describe(err);
    logger.warn({ erro: d.error, ...params }, 'spine: falha no BI de origem de leads');
    return { ok: false, ...d };
  }
}

export function normalizarWhatsapp(bruto: string): string {
  const digitos = bruto.replace(/\D/g, '');
  if (digitos.length === 0) return '';
  if (digitos.startsWith('55') && digitos.length >= 12) return `+${digitos}`;
  if (digitos.length === 10 || digitos.length === 11) return `+55${digitos}`;
  return `+${digitos}`;
}

const UF_POR_NOME: Record<string, string> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA',
  ceara: 'CE', 'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO',
  maranhao: 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS',
  'minas gerais': 'MG', para: 'PA', paraiba: 'PB', parana: 'PR',
  pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO',
  roraima: 'RR', 'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE',
  tocantins: 'TO',
};

const SIGLAS = new Set(Object.values(UF_POR_NOME));

export function resolverUf(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  const t = bruto.trim();
  if (t.length === 2 && SIGLAS.has(t.toUpperCase())) return t.toUpperCase();
  const chave = t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  return UF_POR_NOME[chave] ?? null;
}

export interface SpineLeadResumo {
  idLead: number;
  name: string | null;
  whatsapp: string | null;
  idSource: number | null;
}

export async function searchLeads(
  unit: SpineUnit,
  params: { initialDate: string; endDate: string },
): Promise<SpineResult<{ leads: SpineLeadResumo[] }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };
  const leads: SpineLeadResumo[] = [];
  let page = 1;
  let totalPages = 1;
  try {
    do {
      const { data } = await http.post<{
        data?: {
          data?: Array<{ idLead?: number; name?: string; whatsapp?: string; idSource?: number }>;
          totalPages?: number;
        };
      }>('/api/leads/search', { ...params, pagination: { page, rowsPerPage: 100 } });
      for (const l of data?.data?.data ?? []) {
        if (typeof l.idLead === 'number') {
          leads.push({
            idLead: l.idLead,
            name: l.name ?? null,
            whatsapp: l.whatsapp ?? null,
            idSource: l.idSource ?? null,
          });
        }
      }
      totalPages = Math.max(1, Number(data?.data?.totalPages) || 1);
      page++;
    } while (page <= totalPages && page <= 10);
    return { ok: true, data: { leads } };
  } catch (err) {
    return { ok: false, ...describe(err) };
  }
}

export async function ping(unit: SpineUnit): Promise<SpineResult<{ total: number }>> {
  const http = client(unit);
  if (!http) return { ok: false, error: 'unidade sem token da API Spine' };
  try {
    const { data } = await http.post<{ data?: { total?: number } }>('/api/clients/search', {
      pagination: { page: 1, rowsPerPage: 1 },
    });
    return { ok: true, data: { total: Number(data?.data?.total) || 0 } };
  } catch (err) {
    return { ok: false, ...describe(err) };
  }
}

export const SpineService = {
  createLead,
  createClient,
  searchLeads,
  resolverIdSource,
  nomeDaOrigem,
  resolverUf,
  normalizarWhatsapp,
  searchClients,
  getClient,
  convertLead,
  confirmSchedule,
  biLeadsSources,
  instanteNoFuso,
  localParaUtcIso,
  searchSchedules,
  createSchedule,
  cancelSchedule,
  ping,
  SPINE_STATUS,
};
