// ============================================================================
// spine.service.ts — Cliente da API Spine (franquia Doutor Hérnia).
//
// O QUE ESTA API NÃO TEM, e por que isso define o desenho
// -------------------------------------------------------
// Não existe endpoint de "horários livres" nem de "bloqueios de agenda". O
// único caminho é POST /api/schedules/search, que devolve o HISTÓRICO de
// agendamentos dos pacientes.
//
// Consequência direta: disponibilidade aqui é DEDUZIDA por ausência — "não há
// agendamento nesse horário, logo está livre". E essa dedução tem um furo que
// não dá pra fechar por código: quando o médico bloqueia um horário à mão no
// sistema da franquia, o bloqueio não vira agendamento e não aparece na busca.
// Para nós, aquele horário parece vago.
//
// Por isso este service NÃO tenta adivinhar. Ele faz três coisas:
//   1. ingere o histórico corretamente (paginado, completo);
//   2. converte o fuso — a API responde em UTC e a clínica vive em UTC-3;
//   3. marca o que é incerto, em vez de esconder a incerteza.
//
// A contenção do furo é operacional, não algorítmica: o kill switch que a
// recepção aciona quando a agenda sai do controle.
//
// STATUS — o mapa importa mais que parece
// ---------------------------------------
//   42 Atendido   → ocupado, sem dúvida.
//   41 Remarcado  → ocupado, sem dúvida.
//   57 Desmarcado → o PACIENTE cancelou. Parece vago, mas não garante nada:
//                   o horário pode ter sido bloqueado depois, ou reocupado
//                   fora do sistema. Devolvemos com `requiresManualValidation`
//                   em vez de tratar como livre — um falso "livre" vira
//                   paciente na recepção sem médico.
// ============================================================================

import axios, { type AxiosInstance } from 'axios';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';

/**
 * Fuso padrão quando a unidade não define o dela. A API devolve tudo em UTC.
 *
 * NÃO usamos offset numérico fixo. Parece equivalente hoje — o Brasil não tem
 * horário de verão desde 2019 e Imperatriz é UTC-3 —, mas fixar -3 tem duas
 * formas de quebrar caladas: uma unidade em Manaus (UTC-4) ou Rio Branco
 * (UTC-5), e o dia em que o horário de verão voltar. Nos dois casos o horário
 * continuaria parecendo plausível na tela e o paciente chegaria na hora errada.
 * `Intl` resolve isso com a base de fusos do sistema, que se atualiza sozinha.
 */
const DEFAULT_TZ = 'America/Sao_Paulo';

/** Teto de páginas por varredura — trava contra `totalPages` absurdo. */
const MAX_PAGES = 40;

// LEVANTADOS DA AGENDA REAL (mai–ago/2026), não da documentação:
//   42 ATENDIDO       147
//   57 DESMARCADO     112
//   37 AGENDADO        23   ← consulta futura marcada
//   41 REMARCADO       13
//   38 CONFIRMADO       4
//   40 NÃO COMPARECEU   1
export const SPINE_STATUS = {
  AGENDADO: 37,
  CONFIRMADO: 38,
  NAO_COMPARECEU: 40,
  REMARCADO: 41,
  ATENDIDO: 42,
  DESMARCADO: 57,
} as const;

/**
 * OCUPADO É O PADRÃO. Só o cancelamento explícito libera.
 *
 * A regra estava invertida — uma allowlist com 42 e 41 — e o resultado foi
 * medido: num dia com 5 agendamentos, quatro deles "AGENDADO" (37), a grade
 * mostrou 08:30 e 09:00 como LIVRES. A IA ofereceria horário em cima de
 * paciente marcado.
 *
 * A assimetria dos erros manda no desenho: marcar livre o que está ocupado
 * põe duas pessoas na mesma cadeira; marcar ocupado o que está livre só
 * esconde um horário. O primeiro é incidente, o segundo é desperdício. E
 * quando a franquia criar um status novo, ele entra como ocupado sozinho —
 * uma allowlist precisaria ser lembrada, e ninguém lembra.
 */
const FREE_STATUS: number[] = [SPINE_STATUS.DESMARCADO];

function ocupa(idStatus: number | null): boolean {
  if (idStatus === null) return true; // sem status legível: assume ocupado
  return !FREE_STATUS.includes(idStatus);
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

// FORMATO REAL, medido contra a API de produção — NÃO o da documentação.
// A doc mostra `{ success, data: [...], total }` no topo; a API devolve
// `{ status, data: { data: [...], total, page, rowsPerPage, totalPages } }`.
// Um nível a mais de `data`. Seguir a doc faria a busca voltar sempre vazia,
// e uma agenda vazia é lida como "tudo livre" — o pior erro possível aqui.
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
  /** A API devolve o NOME do profissional, não um id. */
  physicalTherapist: string | null;
  /** Instante original devolvido pela API, em UTC (ISO). */
  dateAttendanceUtc: string | null;
  /** Mesmo instante no fuso da clínica (UTC-3), ISO sem sufixo Z. */
  dateAttendanceLocal: string | null;
  /** "YYYY-MM-DD" no fuso da clínica. */
  dayLocal: string | null;
  /** "HH:mm" no fuso da clínica. */
  timeLocal: string | null;
  /** Ocupa o horário sem margem de dúvida (42, 41). */
  isBusy: boolean;
  /**
   * Cancelado pelo paciente (57). NÃO significa disponível: pode haver
   * bloqueio médico invisível pra API. Quem consumir precisa decidir, e a
   * decisão default deve ser conservadora.
   */
  requiresManualValidation: boolean;
}

export interface SpineResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

// ---------------------------------------------------------------------------
// Cliente HTTP
// ---------------------------------------------------------------------------

export type SpineUnit = Pick<Unit, 'spineBaseUrl' | 'spineToken' | 'spineTimezone'>;

function client(unit: SpineUnit): AxiosInstance | null {
  if (!unit.spineToken) return null;
  return axios.create({
    baseURL: (unit.spineBaseUrl || '').replace(/\/$/, ''),
    // A doc da franquia diz que o servidor corta em 30s. Um timeout nosso
    // MAIOR que o deles só faria a gente esperar por uma resposta que já
    // morreu do outro lado.
    timeout: 30_000,
    headers: {
      Authorization: `Bearer ${unit.spineToken}`,
      'Content-Type': 'application/json',
    },
  });
}

function describe(err: unknown): { error: string; status?: number } {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data as { error?: string; errors?: string[] } | undefined;
    const msg = body?.errors?.join('; ') || body?.error || err.message;
    // Traduz os códigos que a doc lista, porque "401" sozinho não diz a quem
    // olha o painel o que fazer a respeito.
    const humano =
      status === 401
        ? 'token inválido, ausente ou expirado'
        : status === 403
          ? 'token sem permissão para este recurso'
          : status === 404
            ? 'endpoint não encontrado'
            : msg;
    return { error: `${status ?? '?'}: ${humano}`, status };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// Fuso
// ---------------------------------------------------------------------------
// A API devolve `dateAttendance` em UTC (ex.: 2026-07-02T18:00:00.000Z). Sem
// converter, 18:00Z vira "18:00" na tela e a clínica marca três horas errado —
// e o erro passa despercebido porque o número parece plausível.

/** Lê um instante no fuso dado e devolve "YYYY-MM-DDTHH:mm:ss". */
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
  // Alguns motores devolvem "24" para meia-noite com hour12:false.
  const hora = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hora}:${p.minute}:${p.second}`;
}

/** Deslocamento do fuso NAQUELE instante (em ms). Varia com horário de verão. */
function offsetMs(d: Date, tz: string): number {
  return Date.parse(`${instanteNoFuso(d, tz)}Z`) - d.getTime();
}

/**
 * "YYYY-MM-DDTHH:mm:ss" do relógio da clínica → instante UTC.
 *
 * Aplica o offset DUAS vezes de propósito: o deslocamento correto depende do
 * instante, e o instante depende do deslocamento. A primeira passada usa um
 * palpite; a segunda corrige quando o palpite caiu do outro lado de uma
 * virada de horário de verão. Sem isso, agendamentos na semana da virada
 * saem uma hora deslocados.
 */
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

// ---------------------------------------------------------------------------
// Busca de agendamentos — paginada até o fim.
// ---------------------------------------------------------------------------
// `endDate` DA API É EXCLUSIVO. Medido, não deduzido:
//   [06/07, 10/07] devolveu atendimentos de 06 a 09
//   [27/07, 29/07] devolveu 27 e 28
//   [05/08, 05/08] devolveu ZERO — mas o dia tem 5 agendamentos
//
// A consulta de UM dia, que é o uso mais comum da recepção, retornaria vazia
// sempre. E vazio aqui não dá erro: vira "18 horários livres" numa agenda
// cheia. Por isso pedimos um dia a mais à API e recortamos de volta no fim —
// o recorte existe pra que, se a semântica mudar do lado deles, a gente
// devolva a mais e não a menos.

/** Soma dias a uma data "YYYY-MM-DD" sem depender de fuso. */
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
      // Silenciar isso faria a busca parecer completa quando não está — e uma
      // agenda "vazia" na segunda metade do mês viraria horário oferecido.
      logger.warn(
        { totalPages, lidas: MAX_PAGES, unit: unit.spineBaseUrl },
        'spine: busca truncada no teto de páginas',
      );
    }

    // Recorte final pelo dia LOCAL: a API filtra pelo relógio da clínica, e o
    // dia extra que pedimos pode trazer atendimentos além do intervalo pedido.
    const dentro = todos.filter(
      (s) => s.dayLocal !== null && s.dayLocal >= params.initialDate && s.dayLocal <= params.endDate,
    );

    return {
      ok: true,
      data: { schedules: dentro, pages: Math.min(totalPages, MAX_PAGES), total: dentro.length },
    };
  } catch (err) {
    const d = describe(err);
    logger.warn({ erro: d.error, ...params }, 'spine: falha ao buscar agendamentos');
    return { ok: false, ...d };
  }
}

// ---------------------------------------------------------------------------
// Criação de agendamento.
// ---------------------------------------------------------------------------

export interface SpineCreateSchedule {
  idClient: number;
  /** ISO 8601 no fuso da clínica, ex.: "2026-08-05T14:30:00". */
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

  // A LEITURA E A ESCRITA USAM FUSOS DIFERENTES. Medido contra a API:
  //
  //   LER   -> devolve UTC com Z  ("2026-08-05T15:00:00.000Z" = 12:00 na clínica)
  //   GRAVAR-> espera hora LOCAL, SEM sufixo. Enviei "2026-12-29T11:00:00"
  //            e a API gravou 2026-12-29T14:00:00Z, ou seja, 11:00 local.
  //            Ela mesma converte.
  //
  // Duas armadilhas nisso, e as duas mordem calado:
  //   1. Converter pra UTC antes de enviar faz a API somar o offset DE NOVO —
  //      o paciente é marcado 3 horas depois. Nada dá erro.
  //   2. Enviar com "Z" devolve 500 sem explicação ("erro inesperado"), o que
  //      manda procurar o problema no lugar errado.
  //
  // A doc diz "ISO 8601, convenção UTC". Não é o que a API faz.
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
    // Mesma incerteza de envelope da busca: aceitamos as duas formas em vez
    // de apostar numa e descobrir em produção, com agendamento real na mão.
    return { ok: true, data: { idSchedule: data?.data?.idSchedule ?? data?.idSchedule } };
  } catch (err) {
    const d = describe(err);
    // Só o essencial no log. Passar o erro cru do axios despeja os headers da
    // requisição — inclusive o Authorization com o token da franquia — e o
    // logger persiste warns no banco. Credencial em log é vazamento silencioso.
    logger.warn({ erro: d.error, input }, 'spine: falha ao criar agendamento');
    return { ok: false, ...d };
  }
}

// ---------------------------------------------------------------------------
// Busca de pacientes.
// ---------------------------------------------------------------------------
// Agendar exige `idClient`, que não existe do lado do Kommo — o lead do CRM e
// o paciente da franquia são cadastros distintos. Esta busca é a ponte.

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

// ---------------------------------------------------------------------------
// Criação de LEAD na franquia.
// ---------------------------------------------------------------------------
// O lead do Kommo e o lead da franquia são registros distintos. Este é o
// caminho de ida: quem chega pelo WhatsApp entra também no CRM da franquia,
// que é onde a clínica opera.
//
// FORMATO APRENDIDO DOS LEADS QUE JÁ EXISTEM, não da doc:
//   idCategory 3   — é o que todos os leads da unidade usam ("CONTATO")
//   whatsapp       — "+5599991665121", com +55
//   addressCity/Uf — "IMPERATRIZ" / "MA", em caixa alta
//   description    — texto livre; usamos a queixa
//
// A doc chama o campo de `idLeadsCategory`; os registros devolvem `idCategory`.
// Mandamos os DOIS, porque descobrir qual é o certo custaria mais uma rodada
// de tentativa e erro contra a produção de um cliente.

/** Categoria "CONTATO" — a única em uso nos leads da unidade. */
export const SPINE_LEAD_CATEGORY_CONTATO = 3;

/**
 * De onde o lead veio, traduzido do vocabulário do Kommo para os ids da
 * franquia. Sem isso todo lead cairia numa origem só e o relatório de origem
 * da clínica — que é como ela decide onde investir — ficaria cego.
 */
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

/** Volta do id para um rótulo legível — a prévia mostra "23" e "Instagram". */
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
  /** "+55DDNNNNNNNNN" */
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

// ---------------------------------------------------------------------------
// PACIENTE (a franquia chama de "client")
//
// É o "CADASTRAR PACIENTE" que aparece dentro de cada lead. O lead é o contato;
// o paciente é o cadastro de verdade, e o campo `idClient` do lead é o elo
// entre os dois.
//
// O QUE A VALIDAÇÃO DELES EXIGE (medido, não suposto):
//   "Origem é obrigatório." / "Nome é obrigatório." / "WhatsApp ou Email é
//   obrigatório." / "Telefone deve iniciar com + seguido do código do país"
//
// Essa última é a pegadinha: /api/leads engole telefone em vários formatos,
// /api/clients EXIGE E.164. Mandar o que serve pro lead dá 400 aqui.
// ---------------------------------------------------------------------------

export interface SpineCreateClient {
  name: string;
  whatsapp?: string | null;
  email?: string | null;
  idSource: number;
  /**
   * Lead de origem. MEDIDO: a API aceita este campo, responde 201 e NÃO
   * estabelece o vínculo — depois de criar, `lead.idClient` continua vazio.
   * Não existe rota de atualização (PUT/PATCH em /api/clients e /api/leads dão
   * 404) e a API não recusa campo desconhecido, então não dá pra descobrir o
   * nome certo sondando. A interface deles liga os dois por outra rota, de
   * sessão. Continuamos mandando: é inócuo e passa a valer sozinho se eles
   * implementarem — mas NADA na tela pode afirmar que o vínculo existe.
   */
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
  // A regra deles é "WhatsApp OU Email". Sem nenhum dos dois o cadastro vira
  // um nome que a recepção não tem como contatar — e não dá pra apagar.
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

// ---------------------------------------------------------------------------
// Paciente por id — a rota que faltava.
// ---------------------------------------------------------------------------
// Descoberta no guia de integração 1.9.3 e confirmada contra a produção (1.9.8).
// Não estava em uso e muda duas coisas:
//
//   1. dá pra CONFERIR um idClient antes de agendar. Sem isto, o único jeito de
//      achar paciente era por nome, e nome casa xará: uma consulta foi marcada
//      no prontuário de outra pessoa com o mesmo primeiro nome.
//   2. o retorno traz `schedules` EMBUTIDOS, com data e status atuais. Reler o
//      agendamento vira UMA chamada por paciente, em vez de varrer a agenda por
//      intervalo de datas — que erra quando a recepção muda o DIA.
//
// NÃO ENCONTRADO NÃO É 404 — medido: devolve HTTP 200 com
//   { "status": "success", "data": { "success": false, "data": null } }
// ou seja, o `{success:false,data:null}` da doc ANINHADO no envelope padrão, e
// com "success" no topo. Tratar só o 404 deixaria passar um paciente que não
// existe como se a leitura tivesse falhado — e "falhou" aqui não recusa o
// agendamento, "não existe" recusa. O 404 fica como rede de segurança.
// ---------------------------------------------------------------------------

export interface SpineClientDetail {
  idClient: number | null;
  name: string | null;
  whatsapp: string | null;
  /** Agendamentos do paciente, já convertidos para o fuso da clínica. */
  schedules: SpineSchedule[];
}

interface SpineRawClientDetail {
  idClient?: number;
  name?: string;
  whatsapp?: string;
  schedules?: Array<{
    idSchedule?: number;
    dateAttendance?: string;
    /** Aqui o campo chama `category`; na busca de agenda chama `categoryName`. */
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
    // 404 aqui é "paciente não existe", não falha de rede — e a diferença
    // importa: uma é motivo pra recusar o agendamento, a outra pra tentar de novo.
    if (d.status === 404) return { ok: true, data: { client: null } };
    logger.warn({ erro: d.error, idClient }, 'spine: falha ao consultar paciente por id');
    return { ok: false, ...d };
  }
}

// ---------------------------------------------------------------------------
// Converter lead em paciente.
// ---------------------------------------------------------------------------
// A ROTA QUE LIGA AS DUAS FICHAS. O lead e o paciente são cadastros distintos
// na franquia, e criar um paciente do zero para quem já entrou como lead deixa
// DOIS registros da mesma pessoa, sem nada ligando um ao outro — o lead com o
// nome que a I.A. tinha no minuto em que espelhou ("ELBER"), o paciente com o
// nome completo ("WELBER ZANOTELLI"). A recepção procura um e acha o outro.
//
// Mandar `idLead` no POST /api/clients NÃO resolve: a API aceita, responde 201
// e não estabelece vínculo nenhum (medido). A rota certa é esta.
//
// A DOC ERRA NOS OBRIGATÓRIOS: diz "apenas idLead + name". A produção exige
// quatro — medido com corpo vazio:
//   "ID do lead é obrigatório." · "ID da origem é obrigatória."
//   "Nome é obrigatório."       · "WhatsApp ou Email é obrigatório."
// ---------------------------------------------------------------------------

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

/**
 * Cancela um agendamento. Diferente de lead e paciente, agendamento TEM
 * exclusão pela API (status DELETED) — é a única escrita nossa na franquia que
 * dá pra desfazer, e é o que torna remarcar possível.
 */
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

// ---------------------------------------------------------------------------
// Confirmação de presença.
// ---------------------------------------------------------------------------
// O PAR QUE FALTAVA DO LEMBRETE. O paciente responde "confirmo" e, até aqui,
// isso morria na conversa: a franquia continuava vendo AGENDADO (37) e a
// recepção ligava de novo pra confirmar o que já estava confirmado.
//
// A rota move o agendamento para SCHEDULE_CONFIRMED (38), marca a notificação
// como confirmada e grava `notificationAt` do lado deles — ou seja, o registro
// é deles, não nosso, e é isso que faz a recepção parar de ligar.
//
// NÃO é destrutiva e NÃO é o oposto de cancelar: confirmar duas vezes não
// quebra nada, e a consulta segue existindo. Por isso ela não pede a
// confirmação-em-dois-passos que o cancelamento pede.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BI — leads por origem.
// ---------------------------------------------------------------------------
// A ORIGEM OFICIAL, e por que ela não é a nossa.
//
// O painel hoje mostra a origem que a SDR digitou no Kommo. A franquia cobra
// pelo número DELA, que sai daqui. Quando os dois divergem, quem ganha a
// discussão é este endpoint — então ele precisa estar na tela ao lado do
// nosso, e não substituindo: a diferença entre os dois É a informação.
//
// A doc pede 1–2 consultas por dia e no máximo 100 dias de intervalo. Um
// painel que recarrega chama isso a cada F5, então o cache não é otimização,
// é obedecer o contrato de uso deles.
// ---------------------------------------------------------------------------

export interface SpineLeadSource {
  sourceName: string;
  total: number;
}

/** Teto do intervalo aceito pela API deles. Pedir mais devolve 400. */
const BI_MAX_DIAS = 100;

const biCache = new Map<string, { em: number; valor: { sources: SpineLeadSource[]; total: number } }>();
const BI_TTL_MS = 60 * 60_000; // 1h — dentro do "1 a 2 vezes ao dia" da doc

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
    // Envelope agrupado DENTRO de `data` — não é array simples, ao contrário
    // dos outros endpoints de busca. A doc avisa disso e desta vez confere.
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

/** A franquia guarda "+5599991665121". O Kommo entrega em vários formatos. */
export function normalizarWhatsapp(bruto: string): string {
  const digitos = bruto.replace(/\D/g, '');
  if (digitos.length === 0) return '';
  // Já veio com DDI do Brasil.
  if (digitos.startsWith('55') && digitos.length >= 12) return `+${digitos}`;
  // 10 ou 11 dígitos = DDD + número, sem país.
  if (digitos.length === 10 || digitos.length === 11) return `+55${digitos}`;
  return `+${digitos}`;
}

/**
 * Nome do estado -> sigla. O Kommo guarda "Maranhão", a franquia quer "MA".
 *
 * Cortar as duas primeiras letras parece resolver e resolve METADE: acerta
 * Maranhão, Bahia e Goiás por coincidência, e erra Minas Gerais ("MI"),
 * Paraná ("PA", que é Pará), Santa Catarina ("SA"), Mato Grosso ("MA", que é
 * Maranhão) e Rio Grande do Sul ("RI"). Cada erro desses é um cadastro
 * permanente no CRM da franquia, com o paciente no estado errado.
 */
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

/** Devolve a sigla, ou null quando não dá pra ter certeza — melhor vazio que errado. */
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

// ---------------------------------------------------------------------------
// Busca de leads — usada pela conferência.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Teste de credencial.
// ---------------------------------------------------------------------------
// A doc sugere validar em /api/clients/search — é o endpoint mais barato que
// exige token válido E permissão. Serve de "ping" pro botão de validar.

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
