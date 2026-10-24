/**
 * Tiquetaque (ponto eletrônico) no conector: funcionários, batidas do dia (quem está trabalhando agora),
 * horas trabalhadas e banco de horas, atrasos e faltas, marcações com tipo e aprovação, e afastamentos. Só
 * leitura — a fonte de produção é o `tiquetaqueGet` (só GET).
 *
 * Uma conta do Tiquetaque cobre várias empresas e clínicas: o token fica numa unidade do conector (ex.
 * `doutor-digital`) e as clínicas aparecem como LOCAIS ("DH - Imperatriz") e EMPREGADORES (razão social)
 * dentro dela. Por isso as ferramentas filtram por `local` e `empregador`.
 *
 * Dado pessoal: por decisão da dona da empresa (24/10/2026), o conector NÃO corta mais campo nenhum — sai o
 * que o Tiquetaque manda, CPF, PIS/NIS, celular, e-mail, nascimento, cidade, valor da hora, foto/selfie e
 * GPS da batida, anexo do atestado e justificativa escrita incluídos. Cada registro ganha os nomes em
 * português que o filtro, o agrupamento e a ordenação usam e leva o registro cru junto
 * (`colaboradorNormalizado`, `espelhoNormalizado`, `batidaNormalizada`, `afastamentoNormalizado`).
 * Registro pequeno (batida, dia do espelho, afastamento, banco de horas) sai SEMPRE inteiro. As duas
 * respostas grandes vêm resumidas por padrão para não estourar o tamanho, e `completo: true` devolve o
 * registro inteiro: a ficha da pessoa em `tiquetaque_colaboradores` e o espelho de ponto, dia a dia, em
 * `tiquetaque_horas`. O cache guarda sempre o registro COMPLETO — o resumo é só na hora de responder.
 *
 * Os campos com nome em português são escritos SEMPRE, mesmo vazios, para que um campo homônimo do bruto
 * nunca ocupe um nome derivado (a rubrica crua `atraso` chega como texto "0.50" e não pode virar o número
 * que a soma usa); `undefined` não vai para o JSON, então a chave continua ausente como antes.
 *
 * O espelho de ponto (`/timesheets`) traz TODOS os funcionários numa chamada paginada — é dele que saem o
 * ponto do dia, as horas, os atrasos e as faltas. Marcações com tipo/aprovação e afastamentos são por
 * funcionário na API (uma chamada por pessoa, 60 por minuto): essas duas leem no máximo `maxColaboradores`
 * pessoas por chamada e avisam quando cortaram.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { instanteNoFuso } from '../franquia-mcp/normalizar.js';
import { Cache, TTL, emParalelo } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada, diasNoPeriodo, somarDias, validarData } from '../franquia-mcp/travas.js';
import { casaNome, normalizar } from './convenia.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';

export interface FonteTiquetaque {
  get<T>(caminho: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

export interface ContaTiquetaque {
  slug: string;
  nome: string;
  fonte: FonteTiquetaque;
}

export interface ContextoTiquetaque {
  contas: Map<string, ContaTiquetaque>;
  cache: Cache;
  /** páginas por listagem */
  maxPaginas: number;
  /** pessoas lidas uma a uma (marcações, afastamentos) por chamada de ferramenta */
  maxColaboradores: number;
  agora: () => number;
}

export function criarContextoTiquetaque(
  contas: Map<string, ContaTiquetaque>,
  op: { maxPaginas?: number; maxColaboradores?: number; agora?: () => number } = {},
): ContextoTiquetaque {
  const agora = op.agora ?? Date.now;
  return { contas, cache: new Cache(agora, 1000), maxPaginas: op.maxPaginas ?? 20, maxColaboradores: op.maxColaboradores ?? 40, agora };
}

export const MAX_CONTAS_TIQUETAQUE = 10;
/** horas e atrasos/faltas: até ~6 meses por chamada (o espelho vem dia a dia) */
export const MAX_DIAS_ESPELHO = 186;
/** marcações: uma chamada por pessoa e o período inteiro numa resposta, então período curto */
export const MAX_DIAS_BATIDAS = 62;
const FUSO = 'America/Sao_Paulo';
const TTL_HOJE = 60_000; // o ponto de hoje muda a cada batida

export function resolverContasTiquetaque(ctx: ContextoTiquetaque, alvo: string | string[]): ContaTiquetaque[] {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma empresa com o Tiquetaque ligado ainda (cadastre o token no painel de integrações).');
  const com = [...ctx.contas.keys()].join(', ');
  const pedidos = Array.isArray(alvo) ? alvo : [alvo];
  if (pedidos.some((p) => p.trim().toLowerCase() === 'todas')) {
    if (ctx.contas.size > MAX_CONTAS_TIQUETAQUE) throw new ErroDeEntrada(`peça até ${MAX_CONTAS_TIQUETAQUE} contas por vez. Com Tiquetaque: ${com}`);
    return [...ctx.contas.values()];
  }
  const achadas: ContaTiquetaque[] = [];
  const faltam: string[] = [];
  for (const p of pedidos) {
    const slug = acharSlug(ctx.contas.keys(), p);
    if (slug && !achadas.some((a) => a.slug === slug)) achadas.push(ctx.contas.get(slug)!);
    else if (!slug) faltam.push(p);
  }
  if (faltam.length) {
    throw new ErroDeEntrada(
      `conta sem Tiquetaque, desconhecida ou ambígua: ${faltam.join(', ')}. Com Tiquetaque: ${com}. ` +
        'No Tiquetaque, as clínicas e empresas do grupo são LOCAIS dentro da conta: use unidade=<conta> e local=<nome>, ex. local="Imperatriz".',
    );
  }
  if (achadas.length > MAX_CONTAS_TIQUETAQUE) throw new ErroDeEntrada(`no máximo ${MAX_CONTAS_TIQUETAQUE} contas por chamada`);
  return achadas;
}

// ----------------------------------------------------------------- formato bruto (só o que lemos)

/** Um funcionário como a API devolve. O que não está declarado aqui chega pela index signature e também sai. */
export interface FuncionarioBruto {
  _id: string;
  full_name?: string | null;
  work_schedule?: string | null;
  contract_data?: {
    registration_number?: string | number | null;
    payment_source?: string | null;
    manager?: string | null;
    admission_date?: string | null;
    dismissal_date?: string | null;
    records_start_date?: string | null;
    department?: string | null;
    job_role?: string | null;
    [sensivel: string]: unknown;
  } | null;
  [sensivel: string]: unknown;
}

interface EmpregadorBruto {
  _id: string;
  name?: string | null;
  period_cut_day?: number | null;
  [sensivel: string]: unknown;
}

interface LocalBruto {
  _id?: string;
  name?: string | null;
  employees?: unknown;
  [sensivel: string]: unknown;
}

interface EscalaBruta {
  _id?: string;
  description?: string | null;
}

interface UsuarioBruto {
  _id?: string;
  full_name?: string | null;
  [sensivel: string]: unknown;
}

export interface EspelhoBruto {
  employee_id?: string | null;
  period?: { start_date?: string | null; end_date?: string | null } | null;
  totals?: Record<string, unknown> | null;
  days?: Record<string, Record<string, unknown> | null> | null;
  hours_bank_summary?: {
    previous_balance?: unknown;
    generated_balance?: unknown;
    created_balance?: unknown;
    final_balance?: unknown;
    [outro: string]: unknown;
  } | null;
  [outro: string]: unknown;
}

export interface BatidaBruta {
  time?: string | null;
  approved?: boolean | null;
  type?: string | null;
  [sensivel: string]: unknown;
}

export interface AfastamentoBruto {
  _id?: string;
  employee_id?: string | null;
  leave_type?: string | null;
  /** a documentação chama de `type`; a API de verdade manda `leave_type` */
  type?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  paid_leave?: boolean | null;
  hours_bank_debit?: boolean | null;
  attachment?: unknown;
  approval_info?: { approved?: boolean | null; change_request?: Record<string, unknown> | null } | null;
  [sensivel: string]: unknown;
}

interface ListaEve<T> {
  _items?: T[] | null;
  _meta?: { total?: number; max_results?: number; page?: number } | null;
}

// ----------------------------------------------------------------- normalização (registro cru + nomes em português)

const texto = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};
const dia = (v: unknown): string | null => {
  const t = texto(v)?.slice(0, 10) ?? null;
  return t && /^\d{4}-\d{2}-\d{2}$/.test(t) && !t.startsWith('0000') ? t : null;
};
const hora = (v: unknown): string | null => {
  const t = texto(v);
  return t && /^\d{2}:\d{2}$/.test(t) ? t : null;
};
/** Horas centesimais do Tiquetaque ("7.50" = 7h30) em número, 2 casas. */
const horas = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const soma = (xs: Array<number | null | undefined>) => Math.round(xs.reduce<number>((s, x) => s + (x ?? 0), 0) * 100) / 100;

/**
 * Os campos com nome em português — é por eles que filtro, agrupamento, busca e ordenação funcionam, e são
 * eles (e só eles) que o `resumirColaborador` projeta na listagem.
 */
export interface ColaboradorEmPortugues {
  id: string;
  nome: string;
  local: string | null;
  empregador: string | null;
  departamento: string | null;
  cargo: string | null;
  escala: string | null;
  gestor: string | null;
  admissao: string | null;
  inicioDosRegistros: string | null;
  desligamento?: string;
  matricula?: string;
}

/** Os campos em português MAIS o registro cru do Tiquetaque (index signature): nada é cortado. */
export interface Colaborador extends ColaboradorEmPortugues {
  [extra: string]: unknown;
}

export interface Referencias {
  locaisDe: Map<string, string[]>;
  empregadores: Map<string, string>;
  escalas: Map<string, string>;
  gestores: Map<string, string>;
}

/**
 * O funcionário como o Tiquetaque manda (CPF, PIS/NIS, celular, e-mail, nascimento, cidade/UF, valor da
 * hora, external_id e as configurações de registro — foto, GPS, cerca virtual — tudo) mais os nomes em
 * português que o filtro e o agrupamento usam, e que, vindo depois no spread, ganham do bruto em caso de
 * choque. Liberado por decisão da dona da empresa em 24/10/2026.
 */
export function colaboradorNormalizado(f: FuncionarioBruto, ref: Referencias): Colaborador {
  const cd = f.contract_data ?? {};
  const id = String(f._id);
  const desligamento = dia(cd.dismissal_date);
  const matricula = texto(cd.registration_number);
  const empregadorId = texto(cd.payment_source);
  const gestorId = texto(cd.manager);
  const escalaId = texto(f.work_schedule);
  return {
    ...f,
    id,
    nome: texto(f.full_name) ?? '(sem nome)',
    local: ref.locaisDe.get(id)?.join(' + ') ?? null,
    empregador: empregadorId ? (ref.empregadores.get(empregadorId) ?? null) : null,
    departamento: texto(cd.department),
    cargo: texto(cd.job_role),
    escala: escalaId ? (ref.escalas.get(escalaId) ?? null) : null,
    gestor: gestorId ? (ref.gestores.get(gestorId) ?? null) : null,
    admissao: dia(cd.admission_date),
    inicioDosRegistros: dia(cd.records_start_date),
    // sempre escritos (mesmo vazios) para que um campo homônimo do bruto não ocupe um nome em português;
    // valor `undefined` não vai para o JSON da resposta: a chave continua ausente como antes
    desligamento: desligamento ?? undefined,
    matricula: matricula ?? undefined,
  };
}

/**
 * PROJETA os campos em português de uma ficha já normalizada (não remonta nada: o que não está aqui
 * continua no registro, e `completo: true` devolve ele inteiro).
 */
export function resumirColaborador(c: Colaborador): ColaboradorEmPortugues {
  return {
    id: c.id,
    nome: c.nome,
    local: c.local,
    empregador: c.empregador,
    departamento: c.departamento,
    cargo: c.cargo,
    escala: c.escala,
    gestor: c.gestor,
    admissao: c.admissao,
    inicioDosRegistros: c.inicioDosRegistros,
    ...(c.desligamento !== undefined ? { desligamento: c.desligamento } : {}),
    ...(c.matricula !== undefined ? { matricula: c.matricula } : {}),
  };
}

/**
 * Rubricas do espelho com o nome daqui. Só as conhecidas entram neste mapa de NÚMEROS (é por ele que o
 * filtro, a soma e a ordenação funcionam); as outras chaves do dia e dos totais saem no registro cru.
 */
const RUBRICAS: Record<string, string> = {
  total: 'trabalhadas',
  horas_normais: 'normais',
  banco_horas: 'bancoDeHoras',
  falta_injustificada: 'faltaInjustificada',
  falta_justificada: 'faltaJustificada',
  abono: 'abono',
  folga: 'folga',
  atraso: 'atraso',
  dsr: 'dsr',
  desconto_dsr: 'descontoDsr',
  inss: 'inss',
  atestado: 'atestado',
  dispensa_legal: 'dispensaLegal',
  adicional_noturno: 'adicionalNoturno',
  hora_noturna_reduzida: 'horaNoturnaReduzida',
  afastamento_nao_remunerado: 'afastamentoNaoRemunerado',
  sobreaviso: 'sobreaviso',
  suspensao: 'suspensao',
  ferias: 'ferias',
};

export function nomeDaRubrica(k: string): string | null {
  if (RUBRICAS[k]) return RUBRICAS[k]!;
  const extra = /^extra_(\d{1,3})$/.exec(k);
  if (extra) return `extra${extra[1]}`;
  const noturna = /^adicional_noturno_extra_(\d{1,3})$/.exec(k);
  return noturna ? `adicionalNoturnoExtra${noturna[1]}` : null;
}

function rubricas(o: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    const nome = nomeDaRubrica(k);
    const h = horas(v);
    if (nome && h !== null && h !== 0) out[nome] = h;
  }
  return out;
}

const extrasDe = (r: Record<string, number>) => soma(Object.entries(r).filter(([k]) => /^extra\d+$/.test(k)).map(([, v]) => v));

/** O dia do espelho inteiro (observação, justificativa, horários crus…) mais os nomes em português. */
export interface DiaDoEspelho {
  data: string;
  batidas: string[];
  horas: Record<string, number>;
  [extra: string]: unknown;
}

export interface BancoDeHoras {
  saldoAnterior: number | null;
  geradoNoPeriodo: number | null;
  lancadoManual: number | null;
  saldoFinal: number | null;
  [extra: string]: unknown;
}

export interface Espelho {
  id: string;
  periodo: { inicio: string | null; fim: string | null };
  totais: Record<string, number>;
  dias: DiaDoEspelho[];
  bancoDeHoras?: BancoDeHoras;
  [extra: string]: unknown;
}

/**
 * O espelho inteiro como o Tiquetaque manda (os totais crus com as rubricas que não têm nome daqui, o dia
 * cru com a observação e os horários sem filtro, o resumo do banco inteiro) mais as batidas em HH:MM e as
 * horas por rubrica com nome em português, que ganham do bruto no spread.
 */
export function espelhoNormalizado(e: EspelhoBruto): Espelho | null {
  const id = texto(e.employee_id);
  if (!id) return null;
  const dias: DiaDoEspelho[] = [];
  for (const [d, v] of Object.entries(e.days ?? {})) {
    const data = dia(d);
    if (!data || !v || typeof v !== 'object') continue;
    const batidas = Array.isArray(v.horarios) ? v.horarios.map(hora).filter((h): h is string => !!h) : [];
    dias.push({ ...v, data, batidas, horas: rubricas(v) });
  }
  dias.sort((a, b) => a.data.localeCompare(b.data));
  const b = e.hours_bank_summary;
  // `dias` já leva cada dia CRU inteiro (spread de `v`): repetir o mapa `days` do bruto dobraria o espelho
  // (1,6x medido num mês) sem acrescentar um dado. Só o que `dias` não soube ler — data que não é
  // AAAA-MM-DD, valor que não é objeto — sai em `diasNaoLidos`, para não cortar nada.
  const { days, ...resto } = e;
  const naoLidos = Object.entries(days ?? {}).filter(([d, v]) => !dia(d) || !v || typeof v !== 'object');
  return {
    ...resto,
    ...(naoLidos.length ? { diasNaoLidos: Object.fromEntries(naoLidos) } : {}),
    id,
    periodo: { inicio: dia(e.period?.start_date), fim: dia(e.period?.end_date) },
    totais: rubricas(e.totals),
    dias,
    bancoDeHoras: b && typeof b === 'object'
      ? { ...b, saldoAnterior: horas(b.previous_balance), geradoNoPeriodo: horas(b.generated_balance), lancadoManual: horas(b.created_balance), saldoFinal: horas(b.final_balance) }
      : undefined,
  };
}

export interface Batida {
  data: string;
  hora: string;
  tipo: string;
  aprovada: boolean;
  [extra: string]: unknown;
}

/**
 * A marcação inteira: data, hora, tipo (app, web, aparelho, ajuste manual…) e aprovação com nome em
 * português, mais o registro cru — foto/selfie, GPS, dispositivo e justificativa escrita inclusive.
 */
export function batidaNormalizada(b: BatidaBruta): Batida | null {
  const t = texto(b.time);
  const m = t ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(t) : null;
  if (!m) return null;
  return { ...b, data: m[1]!, hora: m[2]!, tipo: texto(b.type) ?? 'sem tipo', aprovada: b.approved === true };
}

const TIPOS_AFASTAMENTO: Record<string, string> = {
  abono: 'abono', afastamento: 'afastamento', atestado: 'atestado', dispensa_legal: 'dispensa legal',
  falta_justificada: 'falta justificada', falta_injustificada: 'falta injustificada', ferias: 'férias',
  folga: 'folga', inss: 'INSS', suspensao: 'suspensão',
};

export interface Afastamento {
  tipo: string;
  inicio: string | null;
  fim: string | null;
  horaInicio?: string;
  horaFim?: string;
  situacao: 'aprovado' | 'pendente' | 'reprovado';
  remunerado: boolean | null;
  descontaDoBanco?: boolean;
  temAnexo: boolean;
  [extra: string]: unknown;
}

/**
 * O afastamento inteiro: tipo, datas (e horas, se for parcial), situação e se é remunerado com nome em
 * português, mais o registro cru — anexo do atestado, justificativa escrita e quem aprovou inclusive.
 */
export function afastamentoNormalizado(a: AfastamentoBruto): Afastamento {
  const bruto = texto(a.leave_type) ?? texto(a.type) ?? '';
  const cr = a.approval_info?.change_request ?? {};
  const reprovado = !!(cr && (cr.rejected_date || cr.rejected_by));
  const horaInicio = hora(a.start_time);
  const horaFim = hora(a.end_time);
  return {
    ...a,
    tipo: TIPOS_AFASTAMENTO[bruto] ?? (bruto || 'sem tipo'),
    inicio: dia(a.start_date),
    fim: dia(a.end_date) ?? dia(a.start_date),
    // sempre escritos (mesmo vazios) para que um campo homônimo do bruto não ocupe um nome em português;
    // valor `undefined` não vai para o JSON da resposta: a chave continua ausente como antes
    horaInicio: horaInicio ?? undefined,
    horaFim: horaFim ?? undefined,
    situacao: a.approval_info?.approved === true ? 'aprovado' : reprovado ? 'reprovado' : 'pendente',
    remunerado: typeof a.paid_leave === 'boolean' ? a.paid_leave : null,
    descontaDoBanco: typeof a.hours_bank_debit === 'boolean' ? a.hours_bank_debit : undefined,
    temAnexo: !!texto(a.attachment),
  };
}

// ----------------------------------------------------------------- leitura

async function comCache<T>(ctx: ContextoTiquetaque, chave: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const g = ctx.cache.pegar<T>(chave);
  if (g !== undefined) return g;
  const v = await fn();
  if (!(v as { truncado?: unknown })?.truncado) ctx.cache.guardar(chave, v, ttl);
  return v;
}

/** Listagem paginada do Tiquetaque (Eve: `max_results` + `page`, `_meta.total`), com teto de páginas. */
async function paginar<T>(
  ctx: ContextoTiquetaque,
  c: ContaTiquetaque,
  caminho: string,
  query: Record<string, string | number | undefined> = {},
  porPagina = 100,
): Promise<{ itens: T[]; truncado: boolean }> {
  const itens: T[] = [];
  for (let p = 1; p <= ctx.maxPaginas; p++) {
    const r = await c.fonte.get<ListaEve<T>>(caminho, { ...query, max_results: porPagina, page: p });
    const d = Array.isArray(r?._items) ? r._items : [];
    itens.push(...d);
    const total = Number(r?._meta?.total);
    const tamanho = Number(r?._meta?.max_results) || porPagina;
    const acabou = Number.isFinite(total) ? p * tamanho >= total : d.length < tamanho;
    if (acabou || d.length === 0) return { itens, truncado: false };
  }
  return { itens, truncado: true };
}

export interface Cadastro {
  colaboradores: Colaborador[];
  porId: Map<string, Colaborador>;
  /** empregador de cada funcionário (id), para achar a folha certa de cada um */
  empregadorDe: Map<string, string>;
  empregadores: Array<{ id: string; nome: string; corte: number }>;
  truncado: boolean;
  avisos: string[];
}

const porNome = (a: { nome: string }, b: { nome: string }) => a.nome.localeCompare(b.nome, 'pt-BR');

/** Funcionários ativos normalizados, com os nomes de local, empregador, escala e gestor. O cache guarda a ficha COMPLETA. */
async function cadastro(ctx: ContextoTiquetaque, c: ContaTiquetaque): Promise<Cadastro> {
  return comCache(ctx, `cadastro|${c.slug}`, TTL.busca, async () => {
    const avisos: string[] = [];
    const opcional = async <T>(o: string, fn: () => Promise<{ itens: T[]; truncado: boolean }>) => {
      try {
        return await fn();
      } catch (e) {
        avisos.push(`${o} não foram lidos (${e instanceof Error ? e.message : String(e)})`);
        return { itens: [] as T[], truncado: false };
      }
    };
    const [func, emp, locais, escalas, usuarios] = await Promise.all([
      paginar<FuncionarioBruto>(ctx, c, '/employees', {}, 500),
      paginar<EmpregadorBruto>(ctx, c, '/payment-sources'),
      opcional('os locais', () => paginar<LocalBruto>(ctx, c, '/sites')),
      opcional('as escalas', () => paginar<EscalaBruta>(ctx, c, '/work-schedules/summary')),
      opcional('os gestores', () => paginar<UsuarioBruto>(ctx, c, '/users')),
    ]);
    const ref: Referencias = { locaisDe: new Map(), empregadores: new Map(), escalas: new Map(), gestores: new Map() };
    for (const l of locais.itens) {
      const nome = texto(l.name);
      if (!nome || !Array.isArray(l.employees)) continue;
      for (const id of l.employees) if (typeof id === 'string') ref.locaisDe.set(id, [...(ref.locaisDe.get(id) ?? []), nome]);
    }
    const empregadores = emp.itens.map((e) => {
      const corte = Number(e.period_cut_day);
      return { id: String(e._id), nome: texto(e.name) ?? '(sem nome)', corte: Number.isInteger(corte) && corte >= 1 && corte <= 31 ? corte : 31 };
    });
    for (const e of empregadores) ref.empregadores.set(e.id, e.nome);
    for (const s of escalas.itens) if (s._id && texto(s.description)) ref.escalas.set(String(s._id), texto(s.description)!);
    for (const u of usuarios.itens) if (u._id && texto(u.full_name)) ref.gestores.set(String(u._id), texto(u.full_name)!);
    const empregadorDe = new Map<string, string>();
    for (const f of func.itens) {
      const e = texto(f.contract_data?.payment_source);
      if (e) empregadorDe.set(String(f._id), e);
    }
    const colaboradores = func.itens.map((f) => colaboradorNormalizado(f, ref)).sort(porNome);
    return {
      colaboradores,
      porId: new Map(colaboradores.map((x) => [x.id, x])),
      empregadorDe,
      empregadores,
      truncado: func.truncado || emp.truncado || locais.truncado,
      avisos,
    };
  });
}

/** Espelhos de todos os funcionários no período, normalizados. O cache guarda o espelho COMPLETO. */
async function espelhos(ctx: ContextoTiquetaque, c: ContaTiquetaque, inicio: string, fim: string): Promise<{ porId: Map<string, Espelho>; truncado: boolean }> {
  const hoje = hojeNoFusoDe(ctx);
  return comCache(ctx, `espelho|${c.slug}|${inicio}|${fim}`, fim >= hoje ? TTL_HOJE : TTL.busca, async () => {
    const { itens, truncado } = await paginar<EspelhoBruto>(ctx, c, '/timesheets', { start_date: inicio, end_date: fim });
    const porId = new Map<string, Espelho>();
    for (const e of itens) {
      const s = espelhoNormalizado(e);
      if (s) porId.set(s.id, s);
    }
    return { porId, truncado };
  });
}

// ----------------------------------------------------------------- filtros e contas

const hojeNoFusoDe = (ctx: ContextoTiquetaque) => instanteNoFuso(new Date(ctx.agora()), FUSO).slice(0, 10);

function periodo(inicio: string, fim: string, max: number): void {
  validarData(inicio, 'inicio');
  validarData(fim, 'fim');
  if (fim < inicio) throw new ErroDeEntrada('fim antes do início');
  if (diasNoPeriodo(inicio, fim) > max) throw new ErroDeEntrada(`período de no máximo ${max} dias por chamada (pedido: ${diasNoPeriodo(inicio, fim)})`);
}

const contem = (valor: string | null | undefined, pedido?: string) => !pedido || (!!valor && normalizar(valor).includes(normalizar(pedido)));
const noPeriodo = (d: string | null, de?: string, ate?: string) => (!de && !ate) || (!!d && (!de || d >= de) && (!ate || d <= ate));

export interface FiltroPessoa {
  local?: string;
  empregador?: string;
  departamento?: string;
  cargo?: string;
  escala?: string;
  gestor?: string;
  busca?: string;
}

const passa = (c: Colaborador, f: FiltroPessoa) =>
  contem(c.local, f.local) && contem(c.empregador, f.empregador) && contem(c.departamento, f.departamento) && contem(c.cargo, f.cargo) &&
  contem(c.escala, f.escala) && contem(c.gestor, f.gestor) && (!f.busca || casaNome(c, f.busca));

function contar<T>(xs: T[], chave: (x: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = chave(x) || '(vazio)';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** Em cada conta, isolada: uma com erro não derruba as outras; "rede" soma só as que responderam. */
async function emCada<T extends object>(contas: ContaTiquetaque[], fn: (c: ContaTiquetaque) => Promise<T>) {
  const porUnidade: Record<string, ({ ok: true } & T) | { ok: false; erro: string }> = {};
  for (const c of contas) {
    try {
      porUnidade[c.slug] = { ok: true, ...(await fn(c)) };
    } catch (e) {
      porUnidade[c.slug] = { ok: false, erro: e instanceof Error ? e.message : String(e) };
    }
  }
  return porUnidade;
}

const foraDoTotal = (porUnidade: Record<string, { ok: boolean }>) => Object.entries(porUnidade).filter(([, u]) => !u.ok).map(([s]) => s);
const incompletas = (porUnidade: Record<string, { ok: boolean }>) =>
  Object.entries(porUnidade).filter(([, u]) => u.ok && ('incompleto' in u || 'truncado' in u)).map(([s]) => s);
const okDe = <T extends { ok: boolean }>(porUnidade: Record<string, T>) => Object.values(porUnidade).filter((u): u is Extract<T, { ok: true }> => u.ok);

const avisoDoCadastro = (cad: Cadastro, truncadoEspelho = false) => {
  const avisos = [
    ...cad.avisos,
    ...(cad.truncado || truncadoEspelho ? ['a listagem do Tiquetaque passou do teto de páginas: os números são parciais'] : []),
  ];
  return { ...(cad.truncado || truncadoEspelho ? { incompleto: true } : {}), ...(avisos.length ? { aviso: avisos.join(' · ') } : {}) };
};

/** O corte das leituras uma a uma somado aos avisos do cadastro. */
function juntarAvisos(corte: { incompleto?: boolean; aviso?: string }, base: { incompleto?: boolean; aviso?: string }) {
  const aviso = [corte.aviso, base.aviso].filter(Boolean).join(' · ');
  return { ...(corte.incompleto || base.incompleto ? { incompleto: true as const } : {}), ...(aviso ? { aviso } : {}) };
}

/** Pessoas do filtro para as leituras uma a uma, com o teto aplicado. */
async function alvos(ctx: ContextoTiquetaque, c: ContaTiquetaque, f: FiltroPessoa) {
  const cad = await cadastro(ctx, c);
  const filtrados = cad.colaboradores.filter((x) => passa(x, f));
  const lidos = filtrados.slice(0, ctx.maxColaboradores);
  return {
    cad,
    lidos,
    corte: {
      colaboradoresLidos: lidos.length,
      colaboradoresNoFiltro: filtrados.length,
      ...(lidos.length < filtrados.length
        ? { truncado: true, incompleto: true, aviso: `li ${lidos.length} de ${filtrados.length} pessoas (o Tiquetaque aceita 60 chamadas por minuto): filtre por local, departamento ou nome para ver o resto` }
        : {}),
    },
  };
}

/**
 * Quem é a pessoa numa linha de ponto, batida, atraso ou afastamento: só identifica. A ficha inteira (CPF,
 * PIS, celular, nascimento, valor da hora…) sai em `tiquetaque_colaboradores` com `completo: true`.
 */
const resumoPessoa = (c: Colaborador) => ({ nome: c.nome, local: c.local, departamento: c.departamento, cargo: c.cargo });

// ----------------------------------------------------------------- tiquetaque_colaboradores

export type AgruparColaboradores = 'local' | 'empregador' | 'departamento' | 'cargo' | 'escala' | 'gestor' | 'mesAdmissao';

const CHAVE_COLAB: Record<AgruparColaboradores, (c: Colaborador) => string | null | undefined> = {
  local: (c) => c.local, empregador: (c) => c.empregador, departamento: (c) => c.departamento, cargo: (c) => c.cargo,
  escala: (c) => c.escala, gestor: (c) => c.gestor, mesAdmissao: (c) => c.admissao?.slice(0, 7),
};

export interface ArgsColaboradores extends FiltroPessoa {
  unidade: string | string[];
  admitidosDe?: string;
  admitidosAte?: string;
  agruparPor?: AgruparColaboradores;
  maxItens?: number;
  /** `true` devolve a ficha inteira de cada pessoa; ausente devolve o resumo em português. */
  completo?: boolean;
}

export async function tiquetaqueColaboradores(ctx: ContextoTiquetaque, a: ArgsColaboradores) {
  if (a.admitidosDe) validarData(a.admitidosDe, 'admitidosDe');
  if (a.admitidosAte) validarData(a.admitidosAte, 'admitidosAte');
  if (a.admitidosDe && a.admitidosAte && a.admitidosAte < a.admitidosDe) throw new ErroDeEntrada('admitidosAte antes de admitidosDe');
  const contas = resolverContasTiquetaque(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 100 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const cad = await cadastro(ctx, c);
    const filtrados = cad.colaboradores.filter((x) => passa(x, a) && noPeriodo(x.admissao, a.admitidosDe, a.admitidosAte));
    return {
      total: filtrados.length,
      ...(a.agruparPor ? { agrupado: contar(filtrados, CHAVE_COLAB[a.agruparPor]) } : {}),
      ...avisoDoCadastro(cad),
      // o cache guarda a ficha completa; o corte é só na resposta
      itens: filtrados.slice(0, max).map((x): Colaborador | ColaboradorEmPortugues => (a.completo ? x : resumirColaborador(x))),
    };
  });
  const ok = okDe(porUnidade);
  return {
    situacao: 'ativos',
    ...(contas.length > 1 ? { rede: { colaboradores: ok.reduce((s, u) => s + u.total, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } } : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- tiquetaque_ponto_do_dia

export type SituacaoDoDia = 'trabalhando' | 'fora' | 'semBatida' | 'comAtraso' | 'comFalta';

/** Situação de uma pessoa num dia, pelas batidas: ímpar = entrou e não saiu (hoje: trabalhando agora). */
export function situacaoDoDia(batidas: string[], temEspelho: boolean, ehHoje: boolean): string {
  if (!temEspelho) return 'sem espelho';
  if (!batidas.length) return 'sem batida';
  if (batidas.length % 2 === 1) return ehHoje ? 'trabalhando' : 'batida ímpar (falta uma marcação)';
  return ehHoje ? 'saiu ou em intervalo' : 'com batidas';
}

/** O dia do espelho sai inteiro; o tipo precisa dizer isso (o spread sozinho perde a index signature). */
type ItemDoDia = Partial<DiaDoEspelho> & {
  nome: string;
  local: string | null;
  departamento: string | null;
  cargo: string | null;
  situacao: string;
  batidas: string[];
  horasTrabalhadas?: number;
  atraso?: number;
  faltaInjustificada?: number;
  faltaJustificada?: number;
  extras?: number;
};

export interface ResumoDoDia {
  colaboradores: number;
  /** hoje: número ímpar de batidas */
  trabalhandoAgora?: number;
  saiuOuEmIntervalo?: number;
  /** dia passado: número ímpar de batidas = faltou uma marcação */
  comBatidaImpar?: number;
  comBatidasPares?: number;
  semBatida: number;
  semEspelho: number;
  comAtraso: number;
  horasDeAtraso: number;
  comFalta?: number;
}

export async function tiquetaquePontoDoDia(
  ctx: ContextoTiquetaque,
  a: FiltroPessoa & { unidade: string | string[]; data?: string; situacao?: SituacaoDoDia; agruparPor?: 'situacao' | 'local' | 'empregador' | 'departamento' | 'cargo'; maxItens?: number },
) {
  const agoraLocal = instanteNoFuso(new Date(ctx.agora()), FUSO);
  const hoje = agoraLocal.slice(0, 10);
  const data = a.data ?? hoje;
  validarData(data, 'data');
  if (data > hoje) throw new ErroDeEntrada('data no futuro: o ponto só existe até hoje');
  const ehHoje = data === hoje;
  const contas = resolverContasTiquetaque(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 200 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const cad = await cadastro(ctx, c);
    const esp = await espelhos(ctx, c, data, data);
    const linhas = cad.colaboradores.filter((x) => passa(x, a)).map((p) => {
      const e = esp.porId.get(p.id);
      const d = e?.dias.find((x) => x.data === data);
      const batidas = d?.batidas ?? [];
      const h = d?.horas ?? {};
      // falta de HOJE ainda não é falta: pode ser só quem não chegou
      const faltaInjustificada = ehHoje ? undefined : h.faltaInjustificada;
      const situacao = situacaoDoDia(batidas, !!e, ehHoje);
      // o mapa de horas em português da linha não pode contradizer o resumo: se a falta de hoje não conta
      // como falta, ela também não entra aqui. A rubrica CRUA do dia (`falta_injustificada`) continua na
      // resposta — quem quiser o número do Tiquetaque tem ele, só não vem com o nome do campo derivado
      const horasDoDia = ehHoje && h.faltaInjustificada !== undefined
        ? (Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'faltaInjustificada')) as Record<string, number>)
        : h;
      // o dia do espelho sai inteiro (horários crus, observação…); os campos em português e a pessoa vêm
      // DEPOIS do spread para que um campo do Tiquetaque com o mesmo nome não troque a pessoa, a situação
      // nem o número (a rubrica crua `atraso` vem como texto "0.25"). Valor `undefined` não vai para o JSON
      // da resposta: a chave continua ausente como antes.
      const item: ItemDoDia = {
        ...d,
        ...resumoPessoa(p),
        situacao,
        batidas,
        horas: horasDoDia,
        horasTrabalhadas: h.trabalhadas,
        atraso: h.atraso,
        faltaInjustificada,
        faltaJustificada: h.faltaJustificada,
        extras: extrasDe(h) || undefined,
      };
      return { p, item, n: batidas.length, temEspelho: !!e, situacao, batidas, atraso: h.atraso, faltaInjustificada, faltaJustificada: h.faltaJustificada };
    });
    type Linha = (typeof linhas)[number];
    const filtro: Record<SituacaoDoDia, (l: Linha) => boolean> = {
      trabalhando: (l) => l.n % 2 === 1,
      fora: (l) => l.n > 0 && l.n % 2 === 0,
      semBatida: (l) => l.n === 0,
      comAtraso: (l) => !!l.atraso,
      comFalta: (l) => !!l.faltaInjustificada || !!l.faltaJustificada,
    };
    const impares = linhas.filter(filtro.trabalhando).length;
    const pares = linhas.filter(filtro.fora).length;
    const resumo: ResumoDoDia = {
      colaboradores: linhas.length,
      ...(ehHoje ? { trabalhandoAgora: impares, saiuOuEmIntervalo: pares } : { comBatidaImpar: impares, comBatidasPares: pares }),
      semBatida: linhas.filter((l) => l.n === 0 && l.temEspelho).length,
      semEspelho: linhas.filter((l) => !l.temEspelho).length,
      comAtraso: linhas.filter(filtro.comAtraso).length,
      horasDeAtraso: soma(linhas.map((l) => l.atraso)),
      ...(ehHoje ? {} : { comFalta: linhas.filter(filtro.comFalta).length }),
    };
    const escolhidas = (a.situacao ? linhas.filter(filtro[a.situacao]) : linhas).sort(
      (x, y) => (x.batidas[0] ?? '99').localeCompare(y.batidas[0] ?? '99') || x.p.nome.localeCompare(y.p.nome, 'pt-BR'),
    );
    const grupo = a.agruparPor;
    return {
      resumo,
      ...(grupo ? { agrupado: contar(escolhidas, (l) => (grupo === 'situacao' ? l.situacao : l.p[grupo])) } : {}),
      ...avisoDoCadastro(cad, esp.truncado),
      itens: escolhidas.slice(0, max).map((l) => l.item),
    };
  });
  const ok = okDe(porUnidade);
  return {
    data,
    ...(ehHoje ? { agora: agoraLocal.slice(11, 16) } : {}),
    observacao:
      'Batidas válidas do espelho de ponto (HH:MM). "trabalhando" = número ímpar de batidas hoje (entrou e ainda não saiu); "sem espelho" = ' +
      'sem escala ou cadastro incompleto no dia. Batida pendente de aprovação pode não aparecer: tiquetaque_batidas mostra tipo e aprovação. ' +
      'Falta de hoje não entra (o dia não acabou). Horas em decimal (7.5 = 7h30). O dia do espelho vem como o Tiquetaque guarda, ' +
      'com os horários crus e a observação do dia — pode trazer dado pessoal e a consulta fica registrada na auditoria.',
    ...(contas.length > 1
      ? { rede: { colaboradores: ok.reduce((s, u) => s + u.resumo.colaboradores, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- folha (mês) e espelho por pessoa

/** Folha do mês `AAAA-MM` para um dia de corte: do dia seguinte ao corte do mês anterior até o corte (31 = mês fechado). */
export function folhaDoMes(mes: string, corte: number): { inicio: string; fim: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new ErroDeEntrada(`mes: use AAAA-MM (recebi "${mes}")`);
  const [ano, m] = mes.split('-').map(Number) as [number, number];
  const ultimo = (a: number, mm: number) => new Date(Date.UTC(a, mm, 0)).getUTCDate();
  const dd = (n: number) => String(n).padStart(2, '0');
  const fim = `${mes}-${dd(Math.min(corte, ultimo(ano, m)))}`;
  const [pa, pm] = m === 1 ? [ano - 1, 12] : [ano, m - 1];
  const inicio = somarDias(`${pa}-${dd(pm)}-${dd(Math.min(corte, ultimo(pa, pm)))}`, 1);
  return { inicio, fim };
}

interface PeriodoPedido {
  mes?: string;
  inicio?: string;
  fim?: string;
}

/**
 * O espelho de cada pessoa no período pedido. Com `mes`, cada empregador usa a SUA folha (dia de corte) —
 * só assim o Tiquetaque calcula o banco de horas. Devolve também os períodos lidos.
 */
async function espelhoPorPessoa(ctx: ContextoTiquetaque, c: ContaTiquetaque, cad: Cadastro, p: PeriodoPedido, max: number) {
  if (p.mes) {
    const cortes = [...new Set(cad.empregadores.map((e) => e.corte))];
    if (!cortes.length) cortes.push(31);
    const periodos = new Map(cortes.map((k) => [k, folhaDoMes(p.mes!, k)]));
    const lidos = new Map<number, Awaited<ReturnType<typeof espelhos>>>();
    for (const [k, per] of periodos) lidos.set(k, await espelhos(ctx, c, per.inicio, per.fim));
    const corteDe = new Map(cad.empregadores.map((e) => [e.id, e.corte]));
    const padrao = cortes[0]!;
    const porId = new Map<string, Espelho>();
    for (const x of cad.colaboradores) {
      const e = cad.empregadorDe.get(x.id);
      const esp = lidos.get((e && corteDe.get(e)) || padrao)?.porId.get(x.id);
      if (esp) porId.set(x.id, esp);
    }
    return { porId, truncado: [...lidos.values()].some((l) => l.truncado), periodos: [...new Set([...periodos.values()].map((x) => `${x.inicio} a ${x.fim}`))], folhaCompleta: true };
  }
  const inicio = p.inicio!;
  const fim = p.fim ?? inicio;
  periodo(inicio, fim, max);
  const r = await espelhos(ctx, c, inicio, fim);
  const folhas = new Set(cad.empregadores.map((e) => { const f = folhaDoMes(fim.slice(0, 7), e.corte); return `${f.inicio}|${f.fim}`; }));
  return { ...r, periodos: [`${inicio} a ${fim}`], folhaCompleta: folhas.size === 1 && folhas.has(`${inicio}|${fim}`) };
}

// ----------------------------------------------------------------- tiquetaque_horas

export type AgruparHoras = 'local' | 'empregador' | 'departamento' | 'cargo';
export type OrdenarHoras = 'nome' | 'trabalhadas' | 'extras' | 'atraso' | 'faltas' | 'bancoDeHoras';

export async function tiquetaqueHoras(
  ctx: ContextoTiquetaque,
  a: FiltroPessoa & PeriodoPedido & { unidade: string | string[]; agruparPor?: AgruparHoras; ordenarPor?: OrdenarHoras; maxItens?: number; completo?: boolean },
) {
  if (a.mes && (a.inicio || a.fim)) throw new ErroDeEntrada('use mes OU inicio/fim');
  if (!a.mes && a.fim && !a.inicio) throw new ErroDeEntrada('fim sem inicio');
  if (a.mes) folhaDoMes(a.mes, 31);
  if (a.inicio) periodo(a.inicio, a.fim ?? a.inicio, MAX_DIAS_ESPELHO);
  const hoje = hojeNoFusoDe(ctx);
  const pedido: PeriodoPedido = a.mes || a.inicio ? a : { mes: hoje.slice(0, 7) };
  const contas = resolverContasTiquetaque(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 100 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const cad = await cadastro(ctx, c);
    const esp = await espelhoPorPessoa(ctx, c, cad, pedido, MAX_DIAS_ESPELHO);
    const pessoas = cad.colaboradores.filter((x) => passa(x, a));
    const linhas = pessoas.flatMap((p) => {
      const e = esp.porId.get(p.id);
      if (!e) return [];
      // falta de HOJE ainda não é falta (pode ser só quem não chegou): sai do total
      const t = { ...e.totais };
      const faltaHoje = e.dias.find((d) => d.data === hoje)?.horas.faltaInjustificada;
      if (faltaHoje && t.faltaInjustificada) {
        const resto = soma([t.faltaInjustificada, -faltaHoje]);
        if (resto > 0) t.faltaInjustificada = resto;
        else delete t.faltaInjustificada;
      }
      return [{
        p,
        item: {
          ...resumoPessoa(p),
          ...(esp.periodos.length > 1 ? { periodo: `${e.periodo.inicio} a ${e.periodo.fim}` } : {}),
          horas: t,
          extras: extrasDe(t),
          diasComBatida: e.dias.filter((d) => d.batidas.length).length,
          diasComAtraso: e.dias.filter((d) => d.horas.atraso).length,
          diasComFaltaInjustificada: e.dias.filter((d) => d.horas.faltaInjustificada && d.data !== hoje).length,
          ...(e.bancoDeHoras ? { bancoDeHoras: e.bancoDeHoras } : {}),
          // o espelho é grande (um registro por dia): sai inteiro só a pedido, mas o cache já o guarda assim
          ...(a.completo ? { espelho: e } : {}),
        },
      }];
    });
    const valor: Record<OrdenarHoras, (l: (typeof linhas)[number]['item']) => number> = {
      nome: () => 0,
      trabalhadas: (l) => l.horas.trabalhadas ?? 0,
      extras: (l) => l.extras,
      atraso: (l) => l.horas.atraso ?? 0,
      faltas: (l) => (l.horas.faltaInjustificada ?? 0) + (l.horas.faltaJustificada ?? 0),
      // ranking do banco: quem DEVE mais horas primeiro; sem banco calculado vai para o fim
      bancoDeHoras: (l) => (typeof l.bancoDeHoras?.saldoFinal === 'number' ? -l.bancoDeHoras.saldoFinal : -Infinity),
    };
    const ord = a.ordenarPor ?? 'nome';
    if (ord !== 'nome') linhas.sort((x, y) => valor[ord](y.item) - valor[ord](x.item) || x.p.nome.localeCompare(y.p.nome, 'pt-BR'));
    const itens = linhas.map((l) => l.item);
    const totais: Record<string, number> = {};
    for (const l of itens) for (const [k, v] of Object.entries(l.horas)) totais[k] = soma([totais[k], v]);
    const comBanco = itens.filter((l) => typeof l.bancoDeHoras?.saldoFinal === 'number');
    const grupo = a.agruparPor;
    const agrupado = grupo
      ? Object.fromEntries(
          Object.entries(
            linhas.reduce<Record<string, { pessoas: number; trabalhadas: number; extras: number; atraso: number; faltaInjustificada: number }>>((acc, { p, item }) => {
              const k = p[grupo] || '(vazio)';
              const g = (acc[k] ??= { pessoas: 0, trabalhadas: 0, extras: 0, atraso: 0, faltaInjustificada: 0 });
              g.pessoas++;
              g.trabalhadas = soma([g.trabalhadas, item.horas.trabalhadas]);
              g.extras = soma([g.extras, item.extras]);
              g.atraso = soma([g.atraso, item.horas.atraso]);
              g.faltaInjustificada = soma([g.faltaInjustificada, item.horas.faltaInjustificada]);
              return acc;
            }, {}),
          ).sort((x, y) => y[1].pessoas - x[1].pessoas || x[0].localeCompare(y[0])),
        )
      : undefined;
    const semEspelho = pessoas.filter((x) => !esp.porId.has(x.id)).length;
    const base = avisoDoCadastro(cad, esp.truncado);
    const aviso = [base.aviso, ...(esp.folhaCompleta ? [] : ['banco de horas só vem com a folha inteira: peça mes="AAAA-MM"'])].filter(Boolean).join(' · ');
    return {
      periodos: esp.periodos,
      resumo: {
        colaboradores: itens.length,
        semEspelho,
        totais,
        extras: soma(itens.map((l) => l.extras)),
        ...(comBanco.length
          ? {
              bancoDeHoras: {
                pessoas: comBanco.length,
                saldoTotal: soma(comBanco.map((l) => l.bancoDeHoras!.saldoFinal)),
                negativos: comBanco.filter((l) => l.bancoDeHoras!.saldoFinal! < 0).length,
                positivos: comBanco.filter((l) => l.bancoDeHoras!.saldoFinal! > 0).length,
              },
            }
          : {}),
      },
      ...(agrupado ? { agrupado } : {}),
      ...('incompleto' in base ? { incompleto: true } : {}),
      ...(aviso ? { aviso } : {}),
      itens: itens.slice(0, max),
    };
  });
  const ok = okDe(porUnidade);
  return {
    observacao:
      'Horas em decimal (7.5 = 7h30). "trabalhadas" = total trabalhado; extra50/extra100 = horas extras por faixa; banco de horas: saldo ' +
      'final do período (negativo = deve horas). A falta de HOJE não entra em "horas" (o dia não acabou). completo: true acrescenta o campo ' +
      '"espelho" com o espelho inteiro de cada pessoa, dia a dia, como o Tiquetaque calculou — ali a falta de hoje ESTÁ somada; em caso de ' +
      'divergência, "horas" é o número da resposta. Pode trazer dado pessoal e a consulta fica registrada na auditoria.',
    ...(contas.length > 1
      ? { rede: { colaboradores: ok.reduce((s, u) => s + u.resumo.colaboradores, 0), extras: soma(ok.map((u) => u.resumo.extras)), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- tiquetaque_atrasos_faltas

const DIAS_DA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const diaDaSemana = (d: string) => DIAS_DA_SEMANA[new Date(`${d}T12:00:00Z`).getUTCDay()]!;

export type AgruparOcorrencias = 'colaborador' | 'local' | 'departamento' | 'dia' | 'mes' | 'diaDaSemana';

/** O dia do espelho sai inteiro; o tipo precisa dizer isso (o spread sozinho perde a index signature). */
type OcorrenciaDoDia = DiaDoEspelho & {
  diaDaSemana: string;
  nome: string;
  local: string | null;
  departamento: string | null;
  atraso?: number;
  faltaInjustificada?: number;
  faltaJustificada?: number;
};

export async function tiquetaqueAtrasosFaltas(
  ctx: ContextoTiquetaque,
  a: FiltroPessoa & { unidade: string | string[]; inicio: string; fim: string; tipo?: 'atraso' | 'falta' | 'todos'; agruparPor?: AgruparOcorrencias; maxItens?: number },
) {
  periodo(a.inicio, a.fim, MAX_DIAS_ESPELHO);
  const hoje = hojeNoFusoDe(ctx);
  const tipo = a.tipo ?? 'todos';
  const contas = resolverContasTiquetaque(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 200 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const cad = await cadastro(ctx, c);
    const esp = await espelhos(ctx, c, a.inicio, a.fim);
    const itens = cad.colaboradores.filter((x) => passa(x, a)).flatMap((p) =>
      (esp.porId.get(p.id)?.dias ?? []).flatMap((d): OcorrenciaDoDia[] => {
        const atraso = tipo !== 'falta' ? d.horas.atraso : undefined;
        // falta de hoje ainda não é falta
        const fi = tipo !== 'atraso' && d.data !== hoje ? d.horas.faltaInjustificada : undefined;
        const fj = tipo !== 'atraso' && d.data !== hoje ? d.horas.faltaJustificada : undefined;
        if (!atraso && !fi && !fj) return [];
        // o dia sai inteiro (horários crus, observação, rubricas sem nome daqui); a pessoa e as horas vêm
        // DEPOIS do spread para que um campo do Tiquetaque com o mesmo nome não troque quem se atrasou nem
        // o número (a rubrica crua `atraso` vem como texto "0.50" e não pode ganhar do número). Valor
        // `undefined` não vai para o JSON da resposta: a chave continua ausente como antes.
        return [{
          ...d,
          diaDaSemana: diaDaSemana(d.data), nome: p.nome, local: p.local, departamento: p.departamento,
          atraso, faltaInjustificada: fi, faltaJustificada: fj,
        }];
      }),
    ).sort((x, y) => x.data.localeCompare(y.data) || x.nome.localeCompare(y.nome, 'pt-BR'));
    const chave: Record<AgruparOcorrencias, (x: (typeof itens)[number]) => string | null> = {
      colaborador: (x) => x.nome, local: (x) => x.local, departamento: (x) => x.departamento, dia: (x) => x.data, mes: (x) => x.data.slice(0, 7), diaDaSemana: (x) => x.diaDaSemana,
    };
    const agrupado = a.agruparPor
      ? Object.fromEntries(
          Object.entries(
            itens.reduce<Record<string, { dias: number; atraso: number; diasComAtraso: number; faltaInjustificada: number; diasComFaltaInjustificada: number; faltaJustificada: number }>>((acc, x) => {
              const k = chave[a.agruparPor!](x) || '(vazio)';
              const g = (acc[k] ??= { dias: 0, atraso: 0, diasComAtraso: 0, faltaInjustificada: 0, diasComFaltaInjustificada: 0, faltaJustificada: 0 });
              g.dias++;
              if (x.atraso) { g.diasComAtraso++; g.atraso = soma([g.atraso, x.atraso]); }
              if (x.faltaInjustificada) { g.diasComFaltaInjustificada++; g.faltaInjustificada = soma([g.faltaInjustificada, x.faltaInjustificada]); }
              if (x.faltaJustificada) g.faltaJustificada = soma([g.faltaJustificada, x.faltaJustificada]);
              return acc;
            }, {}),
          ).sort((x, y) => y[1].dias - x[1].dias || x[0].localeCompare(y[0])),
        )
      : undefined;
    const comAtraso = itens.filter((x) => x.atraso);
    const comFalta = itens.filter((x) => x.faltaInjustificada);
    return {
      resumo: {
        ocorrencias: itens.length,
        diasComAtraso: comAtraso.length,
        horasDeAtraso: soma(comAtraso.map((x) => x.atraso)),
        pessoasComAtraso: new Set(comAtraso.map((x) => x.nome)).size,
        diasComFaltaInjustificada: comFalta.length,
        horasDeFaltaInjustificada: soma(comFalta.map((x) => x.faltaInjustificada)),
        pessoasComFaltaInjustificada: new Set(comFalta.map((x) => x.nome)).size,
        diasComFaltaJustificada: itens.filter((x) => x.faltaJustificada).length,
      },
      ...(agrupado ? { agrupado } : {}),
      ...avisoDoCadastro(cad, esp.truncado),
      itens: itens.slice(0, max),
    };
  });
  const ok = okDe(porUnidade);
  return {
    periodo: { inicio: a.inicio, fim: a.fim },
    observacao:
      'Do espelho de ponto, dia a dia. Atraso e falta em horas decimais (0.25 = 15 min). Falta de hoje não entra (o dia não acabou). O dia ' +
      'vem inteiro, como o Tiquetaque guarda (horários crus, observação do dia, rubricas sem nome daqui) — pode trazer dado pessoal e a ' +
      'consulta fica registrada na auditoria.',
    ...(contas.length > 1
      ? { rede: { diasComAtraso: ok.reduce((s, u) => s + u.resumo.diasComAtraso, 0), diasComFaltaInjustificada: ok.reduce((s, u) => s + u.resumo.diasComFaltaInjustificada, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- tiquetaque_batidas

async function batidasDe(ctx: ContextoTiquetaque, c: ContaTiquetaque, id: string, inicio: string, fim: string): Promise<Batida[]> {
  return comCache(ctx, `batidas|${c.slug}|${id}|${inicio}|${fim}`, fim >= hojeNoFusoDe(ctx) ? TTL_HOJE : TTL.busca, async () => {
    const r = await c.fonte.get<{ times?: BatidaBruta[] | null }>('/times', { employee_id: id, start_date: inicio, end_date: fim });
    return (r?.times ?? []).map(batidaNormalizada).filter((b): b is Batida => !!b);
  });
}

/** A batida sai inteira; o tipo precisa dizer isso (o spread sozinho perde a index signature). */
type BatidaDePessoa = Batida & { nome: string; local: string | null };

export async function tiquetaqueBatidas(
  ctx: ContextoTiquetaque,
  a: FiltroPessoa & { unidade: string | string[]; inicio: string; fim?: string; tipo?: string; aprovacao?: 'aprovadas' | 'pendentes' | 'todas'; agruparPor?: 'tipo' | 'aprovacao' | 'colaborador' | 'dia'; maxItens?: number },
) {
  const fim = a.fim ?? a.inicio;
  periodo(a.inicio, fim, MAX_DIAS_BATIDAS);
  const contas = resolverContasTiquetaque(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 300 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const { cad, lidos, corte } = await alvos(ctx, c, a);
    // a batida sai inteira (foto, GPS, dispositivo, justificativa); nome/local vêm DEPOIS do spread para
    // que um campo do Tiquetaque com o mesmo nome não troque de quem é a batida
    const listas = await emParalelo(lidos, 4, async (p) =>
      (await batidasDe(ctx, c, p.id, a.inicio, fim)).map((b): BatidaDePessoa => ({ ...b, nome: p.nome, local: p.local })),
    );
    const itens = listas
      .flat()
      .filter((b) => contem(b.tipo, a.tipo) && (a.aprovacao === 'aprovadas' ? b.aprovada : a.aprovacao === 'pendentes' ? !b.aprovada : true))
      .sort((x, y) => x.data.localeCompare(y.data) || x.nome.localeCompare(y.nome, 'pt-BR') || x.hora.localeCompare(y.hora));
    const chave: Record<'tipo' | 'aprovacao' | 'colaborador' | 'dia', (b: (typeof itens)[number]) => string> = {
      tipo: (b) => b.tipo, aprovacao: (b) => (b.aprovada ? 'aprovada' : 'pendente'), colaborador: (b) => b.nome, dia: (b) => b.data,
    };
    return {
      ...corte,
      batidas: itens.length,
      pessoas: new Set(itens.map((b) => b.nome)).size,
      porTipo: contar(itens, (b) => b.tipo),
      pendentes: itens.filter((b) => !b.aprovada).length,
      ...(a.agruparPor ? { agrupado: contar(itens, chave[a.agruparPor]) } : {}),
      ...juntarAvisos(corte, avisoDoCadastro(cad)),
      itens: itens.slice(0, max),
    };
  });
  const ok = okDe(porUnidade);
  return {
    periodo: { inicio: a.inicio, fim },
    observacao:
      'Todas as marcações, inclusive as pendentes de aprovação e as desconsideradas, com o tipo (app, web, aparelho, reconhecimento facial, ' +
      'ajuste manual…). A marcação vem inteira, como o Tiquetaque guarda: foto/selfie, localização (GPS), dispositivo e justificativa ' +
      'escrita inclusive — pode trazer dado pessoal e a consulta fica registrada na auditoria.',
    ...(contas.length > 1
      ? { rede: { batidas: ok.reduce((s, u) => s + u.batidas, 0), pendentes: ok.reduce((s, u) => s + u.pendentes, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- tiquetaque_afastamentos

async function afastamentosDe(ctx: ContextoTiquetaque, c: ContaTiquetaque, id: string, inicio: string, fim: string) {
  return comCache(ctx, `afast|${c.slug}|${id}|${inicio}|${fim}`, TTL.busca, async () => {
    const { itens, truncado } = await paginar<AfastamentoBruto>(ctx, c, '/work-leaves', { employee_id: id, start_date: inicio, end_date: fim });
    return { itens: itens.map(afastamentoNormalizado), truncado };
  });
}

const sobrepoe = (ini: string | null, fim: string | null, de: string, ate: string) => !!ini && ini <= ate && (fim ?? ini) >= de;

/** O afastamento sai inteiro; o tipo precisa dizer isso (o spread sozinho perde a index signature). */
type AfastamentoDePessoa = Afastamento & { nome: string; local: string | null; departamento: string | null };
type AfastamentoNoPeriodo = AfastamentoDePessoa & { diasNoPeriodo: number };

export async function tiquetaqueAfastamentos(
  ctx: ContextoTiquetaque,
  a: FiltroPessoa & {
    unidade: string | string[];
    inicio: string;
    fim: string;
    tipo?: string;
    situacao?: 'aprovado' | 'pendente' | 'reprovado';
    agruparPor?: 'tipo' | 'situacao' | 'colaborador' | 'local' | 'departamento' | 'mes';
    maxItens?: number;
  },
) {
  periodo(a.inicio, a.fim, MAX_DIAS_ESPELHO);
  const hoje = hojeNoFusoDe(ctx);
  const contas = resolverContasTiquetaque(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 200 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const { cad, lidos, corte } = await alvos(ctx, c, a);
    let truncado = false;
    const listas = await emParalelo(lidos, 4, async (p) => {
      const r = await afastamentosDe(ctx, c, p.id, a.inicio, a.fim);
      truncado ||= r.truncado;
      // o afastamento sai inteiro (anexo do atestado, justificativa escrita, quem aprovou); nome, local e
      // departamento vêm DEPOIS do spread para que um campo do Tiquetaque com o mesmo nome não troque a
      // pessoa nem o agrupamento
      return r.itens.map((x): AfastamentoDePessoa => ({ ...x, nome: p.nome, local: p.local, departamento: p.departamento }));
    });
    const itens = listas
      .flat()
      .filter((x) => sobrepoe(x.inicio, x.fim, a.inicio, a.fim) && contem(x.tipo, a.tipo) && (!a.situacao || x.situacao === a.situacao))
      .map((x): AfastamentoNoPeriodo => ({ ...x, diasNoPeriodo: diasNoPeriodo(x.inicio! > a.inicio ? x.inicio! : a.inicio, (x.fim ?? x.inicio!) < a.fim ? (x.fim ?? x.inicio!) : a.fim) }))
      .sort((x, y) => String(x.inicio).localeCompare(String(y.inicio)) || x.nome.localeCompare(y.nome, 'pt-BR'));
    const chave: Record<string, (x: (typeof itens)[number]) => string | null> = {
      tipo: (x) => x.tipo, situacao: (x) => x.situacao, colaborador: (x) => x.nome, local: (x) => x.local, departamento: (x) => x.departamento, mes: (x) => x.inicio?.slice(0, 7) ?? null,
    };
    return {
      ...corte,
      ocorrencias: itens.length,
      pessoas: new Set(itens.map((x) => x.nome)).size,
      diasNoPeriodo: itens.reduce((s, x) => s + x.diasNoPeriodo, 0),
      porTipo: contar(itens, (x) => x.tipo),
      pendentes: itens.filter((x) => x.situacao === 'pendente').length,
      ...(a.inicio <= hoje && hoje <= a.fim ? { afastadosHoje: new Set(itens.filter((x) => x.situacao === 'aprovado' && sobrepoe(x.inicio, x.fim, hoje, hoje)).map((x) => x.nome)).size } : {}),
      ...(a.agruparPor ? { agrupado: contar(itens, chave[a.agruparPor]!) } : {}),
      ...juntarAvisos(corte, avisoDoCadastro(cad, truncado)),
      itens: itens.slice(0, max),
    };
  });
  const ok = okDe(porUnidade);
  return {
    periodo: { inicio: a.inicio, fim: a.fim },
    observacao:
      'Férias, atestados, folgas, faltas justificadas e outros afastamentos lançados no Tiquetaque. O registro vem inteiro, como o ' +
      'Tiquetaque guarda: anexo do atestado, justificativa escrita e quem aprovou inclusive. Atestado é dado de saúde — pode trazer dado ' +
      'pessoal sensível, a consulta fica registrada na auditoria: use para o que foi pedido e não repasse o resto.',
    ...(contas.length > 1
      ? { rede: { ocorrencias: ok.reduce((s, u) => s + u.ocorrencias, 0), pendentes: ok.reduce((s, u) => s + u.pendentes, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- ferramentas

const unidade = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('conta do Tiquetaque no conector: slug ou nome curto ("doutor-digital"), uma lista, ou "todas". Veja listar_integracoes.');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);
/** Aviso factual: o conector não corta campo nenhum (decisão da dona da empresa, 24/10/2026). */
const AVISO_DADO_PESSOAL =
  ' A resposta pode trazer dado pessoal sensível como o Tiquetaque guarda (CPF, PIS/NIS, telefone, e-mail, data de nascimento, cidade, ' +
  'valor da hora, foto/selfie e localização GPS da batida, anexo de atestado, justificativa escrita) e a consulta fica registrada na auditoria.';
const filtros = {
  local: z.string().optional().describe('parte do nome do local no Tiquetaque, ex. "Imperatriz", "HM", "Instituto Trauma"'),
  empregador: z.string().optional().describe('parte da razão social do empregador'),
  departamento: z.string().optional().describe('parte do nome do departamento, sem acento'),
  cargo: z.string().optional().describe('parte do nome do cargo'),
  busca: z.string().optional().describe('parte do nome da pessoa'),
};
const maxItens = z.number().int().min(0).max(1000).optional();
const completoPessoa = z
  .boolean()
  .optional()
  .describe(
    'true traz a ficha INTEIRA de cada pessoa (CPF, PIS/NIS, telefone, e-mail, nascimento, cidade, valor da hora, exigência de foto e GPS). ' +
      'Padrão (ausente): resumo com nome, local, empregador, departamento, cargo, escala, gestor, matrícula e datas. ' +
      'A ficha inteira é grande: use com filtro ou maxItens.',
  );
const completoEspelho = z
  .boolean()
  .optional()
  .describe(
    'true acrescenta o campo `espelho`: o espelho INTEIRO de cada pessoa, dia a dia, com os horários crus, a observação do dia e os totais ' +
      'como o Tiquetaque calculou — inclusive a falta de HOJE, que o campo `horas` da linha desconta de propósito (o dia não acabou). Em ' +
      'caso de divergência entre `horas` e `espelho.totais`, `horas` é o número da resposta. Padrão (ausente): o resumo de horas da pessoa ' +
      'e o banco de horas, que já vem inteiro. O espelho inteiro é grande (um registro por dia): use com filtro ou maxItens.',
  );

export function registrarFerramentasTiquetaque(server: McpServer, ctx: ContextoTiquetaque, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'tiquetaque_colaboradores',
    {
      title: 'Funcionários no ponto (Tiquetaque)',
      description:
        'Funcionários ATIVOS cadastrados no ponto eletrônico Tiquetaque, com local (clínica/empresa do grupo), empregador, departamento, ' +
        'cargo, escala, gestor e admissão. Uma conta do Tiquetaque cobre várias clínicas e empresas: filtre por local ou empregador. ' +
        'Use agruparPor para contar (quantos por local, departamento, cargo, escala…). A lista vem resumida; completo: true traz a ficha ' +
        'inteira de cada pessoa.' + AVISO_DADO_PESSOAL,
      inputSchema: {
        unidade, ...filtros,
        escala: z.string().optional().describe('parte do nome da escala de trabalho'),
        gestor: z.string().optional().describe('parte do nome do gestor'),
        admitidosDe: data('admitidos a partir de').optional(),
        admitidosAte: data('admitidos até').optional(),
        agruparPor: z.enum(['local', 'empregador', 'departamento', 'cargo', 'escala', 'gestor', 'mesAdmissao']).optional(),
        maxItens,
        completo: completoPessoa,
      },
      annotations: ro,
    },
    (args) => executar('tiquetaque_colaboradores', args, auditar, () => tiquetaqueColaboradores(ctx, args)),
  );
  server.registerTool(
    'tiquetaque_ponto_do_dia',
    {
      title: 'Ponto do dia e quem está trabalhando agora (Tiquetaque)',
      description:
        'As batidas de um dia (padrão: hoje) de cada funcionário e a situação: trabalhando agora (entrou e não saiu), saiu ou em intervalo, ' +
        'sem batida; mais atraso e horas do dia. Use situacao="trabalhando" para "quem está trabalhando agora" e "semBatida" para quem não ' +
        'bateu ponto. O dia do espelho vem inteiro, com os horários crus e a observação do dia.' + AVISO_DADO_PESSOAL,
      inputSchema: {
        unidade, data: data('dia (padrão: hoje)').optional(), ...filtros,
        situacao: z.enum(['trabalhando', 'fora', 'semBatida', 'comAtraso', 'comFalta']).optional(),
        agruparPor: z.enum(['situacao', 'local', 'empregador', 'departamento', 'cargo']).optional(),
        maxItens,
      },
      annotations: ro,
    },
    (args) => executar('tiquetaque_ponto_do_dia', args, auditar, () => tiquetaquePontoDoDia(ctx, args)),
  );
  server.registerTool(
    'tiquetaque_horas',
    {
      title: 'Horas trabalhadas, extras e banco de horas (Tiquetaque)',
      description:
        'Espelho de ponto por funcionário no período: horas trabalhadas, normais, extras por faixa, atraso, faltas, atestado, férias, folga, ' +
        'e o BANCO DE HORAS (saldo anterior, gerado, final). O banco de horas só vem com a folha inteira: peça mes="AAAA-MM" (padrão: o mês ' +
        'atual). Ordene por extras, atraso, faltas ou bancoDeHoras para ranking; agruparPor soma por local/departamento. completo: true ' +
        'acrescenta o espelho inteiro de cada pessoa, dia a dia.' + AVISO_DADO_PESSOAL,
      inputSchema: {
        unidade,
        mes: z.string().optional().describe('folha do mês, AAAA-MM (padrão: mês atual)'),
        inicio: data('início (em vez de mes)').optional(),
        fim: data('fim (em vez de mes)').optional(),
        ...filtros,
        agruparPor: z.enum(['local', 'empregador', 'departamento', 'cargo']).optional(),
        ordenarPor: z.enum(['nome', 'trabalhadas', 'extras', 'atraso', 'faltas', 'bancoDeHoras']).optional(),
        maxItens,
        completo: completoEspelho,
      },
      annotations: ro,
    },
    (args) => executar('tiquetaque_horas', args, auditar, () => tiquetaqueHoras(ctx, args)),
  );
  server.registerTool(
    'tiquetaque_atrasos_faltas',
    {
      title: 'Atrasos e faltas (Tiquetaque)',
      description:
        'Cada dia com atraso ou falta (justificada ou não) no período, por funcionário, com as batidas do dia e as horas. Use agruparPor ' +
        '(colaborador, local, departamento, dia, mes, diaDaSemana) para ranking e contagem. Até 186 dias por chamada. O dia vem inteiro, ' +
        'com os horários crus e a observação do dia.' + AVISO_DADO_PESSOAL,
      inputSchema: {
        unidade, inicio: data('início'), fim: data('fim'), ...filtros,
        tipo: z.enum(['atraso', 'falta', 'todos']).optional(),
        agruparPor: z.enum(['colaborador', 'local', 'departamento', 'dia', 'mes', 'diaDaSemana']).optional(),
        maxItens,
      },
      annotations: ro,
    },
    (args) => executar('tiquetaque_atrasos_faltas', args, auditar, () => tiquetaqueAtrasosFaltas(ctx, args)),
  );
  server.registerTool(
    'tiquetaque_batidas',
    {
      title: 'Marcações de ponto com tipo e aprovação (Tiquetaque)',
      description:
        'Todas as marcações no período (até 62 dias), inclusive pendentes de aprovação, com o tipo (app, web, aparelho, reconhecimento ' +
        'facial, ajuste manual, offline…) e se está aprovada. Serve para auditar ajustes manuais e batidas pendentes. A marcação vem ' +
        'inteira: foto/selfie, localização (GPS), dispositivo e justificativa escrita inclusive. Lê uma pessoa por vez ' +
        '(até 40 por chamada): filtre por nome, local ou departamento.' + AVISO_DADO_PESSOAL,
      inputSchema: {
        unidade, inicio: data('início'), fim: data('fim (padrão: o início)').optional(), ...filtros,
        tipo: z.string().optional().describe('parte do tipo, ex. "ajuste manual", "app"'),
        aprovacao: z.enum(['aprovadas', 'pendentes', 'todas']).optional(),
        agruparPor: z.enum(['tipo', 'aprovacao', 'colaborador', 'dia']).optional(),
        maxItens,
      },
      annotations: ro,
    },
    (args) => executar('tiquetaque_batidas', args, auditar, () => tiquetaqueBatidas(ctx, args)),
  );
  server.registerTool(
    'tiquetaque_afastamentos',
    {
      title: 'Férias, atestados e afastamentos (Tiquetaque)',
      description:
        'Afastamentos lançados no ponto no período: férias, atestado, folga, falta justificada/injustificada, abono, INSS, suspensão — com ' +
        'datas, situação (aprovado, pendente, reprovado), se é remunerado e quantos dias caem no período. O registro vem inteiro: anexo do ' +
        'atestado, justificativa escrita e quem aprovou inclusive. Lê uma pessoa por vez (até 40 por ' +
        'chamada): filtre por local ou departamento.' + AVISO_DADO_PESSOAL,
      inputSchema: {
        unidade, inicio: data('início'), fim: data('fim'), ...filtros,
        tipo: z.string().optional().describe('parte do tipo: férias, atestado, folga, falta justificada, falta injustificada, abono, INSS…'),
        situacao: z.enum(['aprovado', 'pendente', 'reprovado']).optional(),
        agruparPor: z.enum(['tipo', 'situacao', 'colaborador', 'local', 'departamento', 'mes']).optional(),
        maxItens,
      },
      annotations: ro,
    },
    (args) => executar('tiquetaque_afastamentos', args, auditar, () => tiquetaqueAfastamentos(ctx, args)),
  );
}
