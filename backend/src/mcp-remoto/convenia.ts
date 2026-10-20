/**
 * Convênia no conector: colaboradores, admissões e desligamentos, férias e afastamentos das empresas com o
 * token do Convênia no painel de integrações. Só leitura — a fonte de produção é o `conveniaGet` (só GET).
 *
 * LGPD: o Convênia devolve CPF, RG, PIS, CTPS, conta bancária, Pix, endereço, telefones, e-mail pessoal,
 * salário, data de nascimento, deficiência, etnia, ASO, CID do afastamento e anotações livres. NADA disso sai
 * daqui: cada registro é remontado campo a campo por uma lista do que PODE sair (`colaboradorSeguro`,
 * `desligamentoSeguro`, `afastamentoSeguro`…), e o cache guarda só o que já foi remontado.
 *
 * Férias e afastamentos são por colaborador na API (uma chamada por pessoa) e o Convênia aceita 50 por minuto:
 * essas ferramentas leem no máximo `maxColaboradores` pessoas por chamada e avisam quando cortaram.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { Cache, TTL } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { hojeNoFuso } from './tempo.js';
import { acharSlug } from './unidades.js';

export interface FonteConvenia {
  get<T>(caminho: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

export interface ContaConvenia {
  slug: string;
  nome: string;
  fonte: FonteConvenia;
}

export interface ContextoConvenia {
  contas: Map<string, ContaConvenia>;
  cache: Cache;
  /** páginas de 500 por listagem */
  maxPaginas: number;
  /** pessoas lidas uma a uma (férias, afastamentos, detalhe de desligado) por chamada de ferramenta */
  maxColaboradores: number;
  agora: () => number;
}

export function criarContextoConvenia(
  contas: Map<string, ContaConvenia>,
  op: { maxPaginas?: number; maxColaboradores?: number; agora?: () => number } = {},
): ContextoConvenia {
  const agora = op.agora ?? Date.now;
  return { contas, cache: new Cache(agora, 1000), maxPaginas: op.maxPaginas ?? 20, maxColaboradores: op.maxColaboradores ?? 40, agora };
}

export const MAX_CONTAS_CONVENIA = 10;
const FUSO = 'America/Sao_Paulo';
const TTL_DESLIGADO = 6 * 3_600_000; // ficha de quem já saiu quase não muda

export function resolverContasConvenia(ctx: ContextoConvenia, alvo: string | string[]): ContaConvenia[] {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma empresa com o Convênia ligado ainda (cadastre o token no painel de integrações).');
  const pedidos = Array.isArray(alvo) ? alvo : [alvo];
  if (pedidos.some((p) => p.trim().toLowerCase() === 'todas')) {
    if (ctx.contas.size > MAX_CONTAS_CONVENIA) throw new ErroDeEntrada(`peça até ${MAX_CONTAS_CONVENIA} empresas por vez. Com Convênia: ${[...ctx.contas.keys()].join(', ')}`);
    return [...ctx.contas.values()];
  }
  const achadas: ContaConvenia[] = [];
  const faltam: string[] = [];
  for (const p of pedidos) {
    const slug = acharSlug(ctx.contas.keys(), p);
    if (slug && !achadas.some((a) => a.slug === slug)) achadas.push(ctx.contas.get(slug)!);
    else if (!slug) faltam.push(p);
  }
  if (faltam.length) throw new ErroDeEntrada(`empresa sem Convênia, desconhecida ou ambígua: ${faltam.join(', ')}. Com Convênia: ${[...ctx.contas.keys()].join(', ')}`);
  if (achadas.length > MAX_CONTAS_CONVENIA) throw new ErroDeEntrada(`no máximo ${MAX_CONTAS_CONVENIA} empresas por chamada`);
  return achadas;
}

// ----------------------------------------------------------------- formato bruto (só o que lemos)

interface Ref {
  id?: string | number | null;
  name?: string | null;
  last_name?: string | null;
  title?: string | null;
}

/** Um colaborador como a API devolve. Os campos sensíveis chegam (index signature) e nunca saem. */
export interface ColaboradorBruto {
  id: string;
  name?: string | null;
  last_name?: string | null;
  social_name?: string | null;
  status?: string | null;
  hiring_date?: string | null;
  registration?: string | number | null;
  department?: Ref | null;
  job?: Ref | null;
  team?: Ref | null;
  cost_center?: Ref | null;
  supervisor?: Ref | null;
  relationship?: Ref | null;
  intern?: { initial_at?: string | null; finish_at?: string | null } | null;
  experience_period?: { first_end?: string | null; second_end?: string | null; experience_period_type?: string | null } | null;
  payroll?: { registration?: string | number | null } | null;
  [sensivel: string]: unknown;
}

export interface DesligadoBruto {
  id: string;
  dismissal?: {
    date?: string | null;
    type?: Ref | null;
    termination_notice?: { date?: string | null; termination_notice_type?: Ref | null } | null;
    dismissal_step?: Ref | null;
    [sensivel: string]: unknown;
  } | null;
  [sensivel: string]: unknown;
}

interface SolicitacaoBruta {
  id?: string;
  starts_at?: string | null;
  finishes_at?: string | null;
  requested_days?: number | null;
  allowance?: number | null;
  status?: string | null;
  canceled?: unknown;
  [outro: string]: unknown;
}

interface PeriodoBruto {
  id?: string;
  balance?: number | null;
  initial_balance?: number | null;
  purchasing_started_at?: string | null;
  purchasing_finished_at?: string | null;
  concessive_finished_at?: string | null;
  [outro: string]: unknown;
}

interface AfastamentoBruto {
  id?: string;
  motive?: Ref | null;
  type?: Ref | null;
  date_from?: string | null;
  date_to?: string | null;
  total?: number | string | null;
  [sensivel: string]: unknown;
}

interface ColetivaBruta {
  title?: string | null;
  starts_at?: string | null;
  finishes_at?: string | null;
  requested_days?: number | null;
  departments?: unknown;
  [outro: string]: unknown;
}

// ----------------------------------------------------------------- remontagem segura (LGPD)

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
const nomeDe = (n?: unknown, s?: unknown): string | null => texto([texto(n), texto(s)].filter(Boolean).join(' '));
export const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface Colaborador {
  id: string;
  nome: string;
  nomeSocial?: string;
  situacao: string | null;
  admissao: string | null;
  matricula: string | null;
  departamento: string | null;
  cargo: string | null;
  time: string | null;
  centroDeCusto: string | null;
  gestor: string | null;
  vinculo?: string;
  experiencia?: { tipo: string | null; fimPrimeiroPeriodo: string | null; fimSegundoPeriodo: string | null };
  estagio?: { inicio: string | null; fim: string | null };
}

/**
 * O que pode sair de um colaborador. Lista fechada: campo novo que o Convênia acrescentar não vaza.
 * Fora de propósito: CPF/RG/PIS/CTPS/título/CNH/reservista, conta e Pix, endereço, telefones, e-mails,
 * salário, nascimento, deficiência, etnia, gênero, ASO, anotações, contatos de emergência, dependentes.
 */
export function colaboradorSeguro(c: ColaboradorBruto): Colaborador {
  const nome = nomeDe(c.name, c.last_name) ?? '(sem nome)';
  const social = texto(c.social_name);
  const vinculo = texto(c.relationship?.name);
  const exp = c.experience_period;
  const experiencia = exp && (dia(exp.first_end) || dia(exp.second_end))
    ? { tipo: texto(exp.experience_period_type), fimPrimeiroPeriodo: dia(exp.first_end), fimSegundoPeriodo: dia(exp.second_end) }
    : null;
  const estagio = c.intern && (dia(c.intern.initial_at) || dia(c.intern.finish_at)) ? { inicio: dia(c.intern.initial_at), fim: dia(c.intern.finish_at) } : null;
  return {
    id: String(c.id),
    nome,
    ...(social && normalizar(social) !== normalizar(nome) ? { nomeSocial: social } : {}),
    situacao: texto(c.status),
    admissao: dia(c.hiring_date),
    matricula: texto(c.registration) ?? texto(c.payroll?.registration),
    departamento: texto(c.department?.name),
    cargo: texto(c.job?.name),
    time: texto(c.team?.name),
    centroDeCusto: texto(c.cost_center?.name),
    gestor: nomeDe(c.supervisor?.name, c.supervisor?.last_name),
    ...(vinculo ? { vinculo } : {}),
    ...(experiencia ? { experiencia } : {}),
    ...(estagio ? { estagio } : {}),
  };
}

export interface Desligamento {
  data: string | null;
  tipo: string | null;
  avisoPrevio: string | null;
  etapa: string | null;
}

/** Do desligamento sai data, tipo, aviso prévio e etapa. Motivo e comentários (texto livre) e e-mail não saem. */
export function desligamentoSeguro(d: DesligadoBruto): { id: string; desligamento: Desligamento } {
  const x = d.dismissal ?? {};
  return {
    id: String(d.id),
    desligamento: {
      data: dia(x.date),
      tipo: texto(x.type?.title) ?? texto(x.type?.name),
      avisoPrevio: texto(x.termination_notice?.termination_notice_type?.name),
      etapa: texto(x.dismissal_step?.name),
    },
  };
}

const STATUS_FERIAS: Record<string, string> = {
  approved: 'aprovada', pending: 'pendente', waiting: 'pendente', reproved: 'recusada', refused: 'recusada', rejected: 'recusada',
  canceled: 'cancelada', cancelled: 'cancelada', finished: 'concluída', in_progress: 'em andamento',
};

export interface Ferias {
  inicio: string | null;
  fim: string | null;
  dias: number | null;
  abonoDias: number | null;
  status: string;
}

export function solicitacaoSegura(s: SolicitacaoBruta): Ferias {
  const st = String(s.status ?? '').toLowerCase();
  return {
    inicio: dia(s.starts_at),
    fim: dia(s.finishes_at),
    dias: typeof s.requested_days === 'number' ? s.requested_days : null,
    abonoDias: typeof s.allowance === 'number' && s.allowance > 0 ? s.allowance : null,
    status: s.canceled ? 'cancelada' : (STATUS_FERIAS[st] ?? (st || 'sem status')),
  };
}

export interface PeriodoAquisitivo {
  aquisitivo: { inicio: string | null; fim: string | null };
  saldoDias: number | null;
  /** fim do período concessivo: depois dele, férias não tiradas são pagas em dobro */
  limiteParaTirar: string | null;
}

export function periodoSeguro(p: PeriodoBruto): PeriodoAquisitivo {
  return {
    aquisitivo: { inicio: dia(p.purchasing_started_at), fim: dia(p.purchasing_finished_at) },
    saldoDias: typeof p.balance === 'number' ? p.balance : null,
    limiteParaTirar: dia(p.concessive_finished_at),
  };
}

export interface Afastamento {
  motivo: string | null;
  tipo: string | null;
  de: string | null;
  ate: string | null;
  dias: number | null;
}

/** Motivo (ex. "Afastamento por doença") e tipo saem; o CID e a justificativa (dado de saúde, texto livre) nunca. */
export function afastamentoSeguro(a: AfastamentoBruto): Afastamento {
  const total = Number(a.total);
  return {
    motivo: texto(a.motive?.name),
    tipo: texto(a.type?.name),
    de: dia(a.date_from),
    ate: dia(a.date_to) ?? dia(a.date_from),
    dias: Number.isFinite(total) && a.total !== null && a.total !== '' ? total : null,
  };
}

// ----------------------------------------------------------------- leitura

async function comCache<T>(ctx: ContextoConvenia, chave: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const g = ctx.cache.pegar<T>(chave);
  if (g !== undefined) return g;
  const v = await fn();
  if (!(v as { truncado?: unknown })?.truncado) ctx.cache.guardar(chave, v, ttl);
  return v;
}

interface PaginaLaravel<T> {
  data?: T[] | null;
  current_page?: number;
  last_page?: number;
  next_page_url?: string | null;
}

/** Listagem paginada do Convênia (`paginate` + `page`, até 1000 por página), com teto de páginas. */
async function paginar<T>(ctx: ContextoConvenia, c: ContaConvenia, caminho: string, porPagina = 500): Promise<{ itens: T[]; truncado: boolean }> {
  const itens: T[] = [];
  for (let p = 1; p <= ctx.maxPaginas; p++) {
    const r = await c.fonte.get<PaginaLaravel<T>>(caminho, { paginate: porPagina, page: p });
    const d = Array.isArray(r?.data) ? r.data : [];
    itens.push(...d);
    const ultima = Number(r?.last_page);
    const acabou = Number.isFinite(ultima) && ultima > 0 ? p >= ultima : !r?.next_page_url || d.length === 0;
    if (acabou || d.length === 0) return { itens, truncado: false };
  }
  return { itens, truncado: true };
}

async function emParalelo<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await fn(xs[k]!);
      }
    }),
  );
  return out;
}

const porNome = (a: { nome: string }, b: { nome: string }) => a.nome.localeCompare(b.nome, 'pt-BR');

/** Ativos já remontados (o cache nunca guarda o registro bruto). */
async function ativos(ctx: ContextoConvenia, c: ContaConvenia): Promise<{ itens: Colaborador[]; truncado: boolean }> {
  return comCache(ctx, `ativos|${c.slug}`, TTL.busca, async () => {
    const { itens, truncado } = await paginar<ColaboradorBruto>(ctx, c, '/employees');
    return { itens: itens.map(colaboradorSeguro).sort(porNome), truncado };
  });
}

async function desligados(ctx: ContextoConvenia, c: ContaConvenia): Promise<{ itens: Array<{ id: string; desligamento: Desligamento }>; truncado: boolean }> {
  return comCache(ctx, `desligados|${c.slug}`, TTL.busca, async () => {
    const { itens, truncado } = await paginar<DesligadoBruto>(ctx, c, '/employees/dismissed', 1000);
    return { itens: itens.map(desligamentoSeguro), truncado };
  });
}

async function ficha(ctx: ContextoConvenia, c: ContaConvenia, id: string, ttl = TTL.busca): Promise<Colaborador> {
  return comCache(ctx, `ficha|${c.slug}|${id}`, ttl, async () => {
    const r = await c.fonte.get<{ data?: ColaboradorBruto | null }>(`/employees/${encodeURIComponent(id)}`);
    if (!r?.data) throw new ErroDeEntrada(`colaborador ${id} não encontrado no Convênia`);
    return colaboradorSeguro(r.data);
  });
}

export type ColaboradorComSaida = Colaborador & { desligamento?: Desligamento };

/**
 * Desligados que passam no `filtro`, com a ficha (nome, cargo, departamento, admissão) lida uma a uma — a
 * listagem de desligados do Convênia só traz o id e o desligamento. Mais recentes primeiro; além do teto,
 * ficam sem ficha (contados em `semFicha`).
 */
async function desligadosComFicha(
  ctx: ContextoConvenia,
  c: ContaConvenia,
  filtro: (d: Desligamento) => boolean,
): Promise<{ itens: ColaboradorComSaida[]; truncado: boolean; semFicha: number }> {
  const { itens, truncado } = await desligados(ctx, c);
  const alvo = itens.filter((d) => filtro(d.desligamento)).sort((a, b) => String(b.desligamento.data).localeCompare(String(a.desligamento.data)));
  const lidos = alvo.slice(0, ctx.maxColaboradores);
  const fichas = await emParalelo(lidos, 4, async (d) => ({ ...(await ficha(ctx, c, d.id, TTL_DESLIGADO)), situacao: 'Desligado', desligamento: d.desligamento }));
  return { itens: fichas, truncado, semFicha: alvo.length - lidos.length };
}

// ----------------------------------------------------------------- filtros e contas

function periodo(inicio: string | undefined, fim: string | undefined, nome: string): void {
  if (inicio) validarData(inicio, `${nome}De`);
  if (fim) validarData(fim, `${nome}Ate`);
  if (inicio && fim && fim < inicio) throw new ErroDeEntrada(`${nome}Ate antes de ${nome}De`);
}

const noPeriodo = (d: string | null, de?: string, ate?: string) => (!de && !ate) || (!!d && (!de || d >= de) && (!ate || d <= ate));
const sobrepoe = (ini: string | null, fim: string | null, de: string, ate: string) => !!ini && ini <= ate && (fim ?? ini) >= de;
const contem = (valor: string | null | undefined, pedido?: string) => !pedido || (!!valor && normalizar(valor).includes(normalizar(pedido)));

/** Todas as palavras da busca aparecem no nome (ou no nome social), sem acento e sem caixa. */
export function casaNome(c: Pick<Colaborador, 'nome' | 'nomeSocial'>, busca: string): boolean {
  const alvo = normalizar(`${c.nome} ${c.nomeSocial ?? ''}`);
  return normalizar(busca).split(' ').filter(Boolean).every((p) => alvo.includes(p));
}

interface FiltroPessoa {
  departamento?: string;
  cargo?: string;
  time?: string;
  gestor?: string;
  busca?: string;
}

const passa = (c: Colaborador, f: FiltroPessoa) =>
  contem(c.departamento, f.departamento) && contem(c.cargo, f.cargo) && contem(c.time, f.time) && contem(c.gestor, f.gestor) && (!f.busca || casaNome(c, f.busca));

function contar<T>(xs: T[], chave: (x: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = chave(x) || '(vazio)';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** Em cada empresa, isolada: uma com erro não derruba as outras; "rede" soma só as que responderam. */
async function emCada<T extends object>(contas: ContaConvenia[], fn: (c: ContaConvenia) => Promise<T>) {
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

/** Ativos filtrados para as leituras por pessoa, com o teto aplicado. */
async function alvosAtivos(ctx: ContextoConvenia, c: ContaConvenia, f: FiltroPessoa) {
  const { itens, truncado } = await ativos(ctx, c);
  const filtrados = itens.filter((x) => passa(x, f));
  const lidos = filtrados.slice(0, ctx.maxColaboradores);
  return {
    lidos,
    corte: {
      colaboradoresLidos: lidos.length,
      colaboradoresNoFiltro: filtrados.length,
      ...(truncado || lidos.length < filtrados.length
        ? { truncado: true, aviso: `li ${lidos.length} de ${filtrados.length} pessoas (o Convênia aceita 50 chamadas por minuto): filtre por departamento ou cargo para ver o resto` }
        : {}),
    },
  };
}

// ----------------------------------------------------------------- convenia_colaboradores

export type AgruparColaboradores = 'departamento' | 'cargo' | 'time' | 'centroDeCusto' | 'gestor' | 'situacao' | 'vinculo' | 'mesAdmissao' | 'mesDesligamento' | 'tipoDesligamento';

const CHAVE_GRUPO: Record<AgruparColaboradores, (c: ColaboradorComSaida) => string | null | undefined> = {
  departamento: (c) => c.departamento,
  cargo: (c) => c.cargo,
  time: (c) => c.time,
  centroDeCusto: (c) => c.centroDeCusto,
  gestor: (c) => c.gestor,
  situacao: (c) => c.situacao,
  vinculo: (c) => c.vinculo,
  mesAdmissao: (c) => c.admissao?.slice(0, 7),
  mesDesligamento: (c) => c.desligamento?.data?.slice(0, 7),
  tipoDesligamento: (c) => c.desligamento?.tipo,
};

export interface ArgsColaboradores extends FiltroPessoa {
  unidade: string | string[];
  situacao?: 'ativos' | 'desligados' | 'todos';
  admitidosDe?: string;
  admitidosAte?: string;
  desligadosDe?: string;
  desligadosAte?: string;
  agruparPor?: AgruparColaboradores;
  maxItens?: number;
}

export async function conveniaColaboradores(ctx: ContextoConvenia, a: ArgsColaboradores) {
  periodo(a.admitidosDe, a.admitidosAte, 'admitidos');
  periodo(a.desligadosDe, a.desligadosAte, 'desligados');
  const situacao = a.situacao ?? (a.desligadosDe || a.desligadosAte ? 'desligados' : 'ativos');
  if (situacao === 'ativos' && (a.desligadosDe || a.desligadosAte)) throw new ErroDeEntrada('desligadosDe/desligadosAte pedem situacao "desligados" ou "todos"');
  const contas = resolverContasConvenia(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 50 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const lista = new Map<string, ColaboradorComSaida>();
    let truncado = false;
    let semFicha = 0;
    if (situacao !== 'desligados') {
      const r = await ativos(ctx, c);
      for (const x of r.itens) lista.set(x.id, x);
      truncado ||= r.truncado;
    }
    if (situacao !== 'ativos') {
      const r = await desligadosComFicha(ctx, c, (d) => noPeriodo(d.data, a.desligadosDe, a.desligadosAte));
      // quem está na lista de ativos e também em desligamento (aviso prévio correndo) aparece uma vez só
      for (const x of r.itens) lista.set(x.id, lista.has(x.id) ? { ...lista.get(x.id)!, desligamento: x.desligamento } : x);
      truncado ||= r.truncado;
      semFicha = r.semFicha;
    }
    const filtrados = [...lista.values()].filter((x) => passa(x, a) && noPeriodo(x.admissao, a.admitidosDe, a.admitidosAte));
    return {
      total: filtrados.length,
      ...(situacao === 'todos' ? { ativos: filtrados.filter((x) => !x.desligamento).length, desligados: filtrados.filter((x) => x.desligamento).length } : {}),
      ...(a.agruparPor ? { agrupado: contar(filtrados, CHAVE_GRUPO[a.agruparPor]) } : {}),
      ...(truncado ? { truncado } : {}),
      ...(semFicha ? { desligadosSemFicha: semFicha, aviso: `${semFicha} desligados ficaram fora (sem a ficha, não dá para filtrar nem nomear): estreite o período de desligamento` } : {}),
      itens: filtrados.slice(0, max),
    };
  });
  const ok = Object.values(porUnidade).filter((u): u is Extract<typeof u, { ok: true }> => u.ok);
  return {
    situacao,
    ...(contas.length > 1 ? { rede: { colaboradores: ok.reduce((s, u) => s + u.total, 0), unidadesForaDoTotal: foraDoTotal(porUnidade) } } : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- convenia_movimentacao

export async function conveniaMovimentacao(
  ctx: ContextoConvenia,
  a: { unidade: string | string[]; inicio: string; fim: string; departamento?: string; cargo?: string; maxItens?: number },
) {
  validarData(a.inicio, 'inicio');
  validarData(a.fim, 'fim');
  if (a.fim < a.inicio) throw new ErroDeEntrada('fim antes do início');
  const contas = resolverContasConvenia(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 50 : 0);
  const filtro = { departamento: a.departamento, cargo: a.cargo };
  const porUnidade = await emCada(contas, async (c) => {
    const at = await ativos(ctx, c);
    // quem saiu a partir do início pode ter entrado no período: a ficha traz a admissão
    const de = await desligadosComFicha(ctx, c, (d) => !!d.data && d.data >= a.inicio);
    const ids = new Set(at.itens.map((x) => x.id));
    const todos: ColaboradorComSaida[] = [...at.itens, ...de.itens.filter((x) => !ids.has(x.id))].filter((x) => passa(x, filtro));
    const admitidos = todos.filter((x) => noPeriodo(x.admissao, a.inicio, a.fim)).sort((x, y) => String(x.admissao).localeCompare(String(y.admissao)));
    const saidas = de.itens.filter((x) => passa(x, filtro) && noPeriodo(x.desligamento?.data ?? null, a.inicio, a.fim)).sort((x, y) => String(x.desligamento?.data).localeCompare(String(y.desligamento?.data)));
    const porMes: Record<string, { admissoes: number; desligamentos: number }> = {};
    for (const x of admitidos) (porMes[x.admissao!.slice(0, 7)] ??= { admissoes: 0, desligamentos: 0 }).admissoes++;
    for (const x of saidas) (porMes[x.desligamento!.data!.slice(0, 7)] ??= { admissoes: 0, desligamentos: 0 }).desligamentos++;
    return {
      ativosHoje: at.itens.filter((x) => passa(x, filtro)).length,
      admissoes: admitidos.length,
      desligamentos: saidas.length,
      saldo: admitidos.length - saidas.length,
      porMes: Object.fromEntries(Object.entries(porMes).sort(([x], [y]) => x.localeCompare(y))),
      desligamentosPorTipo: contar(saidas, (x) => x.desligamento?.tipo),
      desligamentosPorDepartamento: contar(saidas, (x) => x.departamento),
      admissoesPorDepartamento: contar(admitidos, (x) => x.departamento),
      ...(at.truncado || de.truncado ? { truncado: true } : {}),
      ...(de.semFicha ? { desligadosSemFicha: de.semFicha, aviso: `${de.semFicha} desligamentos desde ${a.inicio} ficaram sem ficha: estreite o período` } : {}),
      itensAdmissoes: admitidos.slice(0, max).map((x) => ({ nome: x.nome, cargo: x.cargo, departamento: x.departamento, admissao: x.admissao })),
      itensDesligamentos: saidas.slice(0, max).map((x) => ({ nome: x.nome, cargo: x.cargo, departamento: x.departamento, admissao: x.admissao, desligamento: x.desligamento })),
    };
  });
  const ok = Object.values(porUnidade).filter((u): u is Extract<typeof u, { ok: true }> => u.ok);
  return {
    periodo: { inicio: a.inicio, fim: a.fim },
    ...(contas.length > 1
      ? { rede: { admissoes: ok.reduce((s, u) => s + u.admissoes, 0), desligamentos: ok.reduce((s, u) => s + u.desligamentos, 0), ativosHoje: ok.reduce((s, u) => s + u.ativosHoje, 0), unidadesForaDoTotal: foraDoTotal(porUnidade) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- convenia_ferias

async function feriasDe(ctx: ContextoConvenia, c: ContaConvenia, id: string) {
  return comCache(ctx, `ferias|${c.slug}|${id}`, TTL.busca, async () => {
    const enc = encodeURIComponent(id);
    const [s, p] = await Promise.all([
      c.fonte.get<PaginaLaravel<SolicitacaoBruta>>(`/employees/${enc}/vacations/solicitations`, { paginate: 200 }),
      c.fonte.get<PaginaLaravel<PeriodoBruto>>(`/employees/${enc}/vacations/periods`, { paginate: 200 }),
    ]);
    return { solicitacoes: (s?.data ?? []).map(solicitacaoSegura), periodos: (p?.data ?? []).map(periodoSeguro) };
  });
}

async function coletivas(ctx: ContextoConvenia, c: ContaConvenia) {
  return comCache(ctx, `coletivas|${c.slug}`, TTL.busca, async () => {
    const { itens, truncado } = await paginar<ColetivaBruta>(ctx, c, '/companies/collective-vacations', 200);
    return {
      truncado,
      itens: itens.map((x) => ({
        titulo: texto(x.title),
        inicio: dia(x.starts_at),
        fim: dia(x.finishes_at),
        dias: typeof x.requested_days === 'number' ? x.requested_days : null,
        departamentos: Array.isArray(x.departments) ? x.departments.map((d) => texto((d as Ref)?.name)).filter((d): d is string => !!d) : [],
      })),
    };
  });
}

function somarDias(data: string, dias: number): string {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export async function conveniaFerias(
  ctx: ContextoConvenia,
  a: { unidade: string | string[]; inicio?: string; fim?: string; departamento?: string; cargo?: string; busca?: string; agruparPor?: 'status' | 'departamento' | 'mes'; maxItens?: number },
) {
  const hoje = hojeNoFuso(FUSO, new Date(ctx.agora()));
  const inicio = a.inicio ?? hoje;
  const fim = a.fim ?? somarDias(inicio, 90);
  validarData(inicio, 'inicio');
  validarData(fim, 'fim');
  if (fim < inicio) throw new ErroDeEntrada('fim antes do início');
  const contas = resolverContasConvenia(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 100 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const { lidos, corte } = await alvosAtivos(ctx, c, a);
    const fichas = await emParalelo(lidos, 4, async (p) => ({ p, f: await feriasDe(ctx, c, p.id) }));
    const ferias = fichas
      .flatMap(({ p, f }) => f.solicitacoes.map((s) => ({ nome: p.nome, cargo: p.cargo, departamento: p.departamento, ...s })))
      .filter((s) => s.status !== 'cancelada' && s.status !== 'recusada' && sobrepoe(s.inicio, s.fim, inicio, fim))
      .sort((x, y) => String(x.inicio).localeCompare(String(y.inicio)));
    const comSaldo = fichas.flatMap(({ p, f }) =>
      f.periodos.filter((x) => (x.saldoDias ?? 0) > 0 && x.limiteParaTirar).map((x) => ({ nome: p.nome, departamento: p.departamento, saldoDias: x.saldoDias, limiteParaTirar: x.limiteParaTirar!, aquisitivo: x.aquisitivo })),
    );
    const vencidas = comSaldo.filter((x) => x.limiteParaTirar < hoje).sort((x, y) => x.limiteParaTirar.localeCompare(y.limiteParaTirar));
    const aVencer = comSaldo.filter((x) => x.limiteParaTirar >= hoje && x.limiteParaTirar <= fim).sort((x, y) => x.limiteParaTirar.localeCompare(y.limiteParaTirar));
    const col = await coletivas(ctx, c).catch((e: unknown) => ({ erro: e instanceof Error ? e.message : String(e) }));
    const chave = a.agruparPor === 'departamento' ? (s: (typeof ferias)[number]) => s.departamento : a.agruparPor === 'mes' ? (s: (typeof ferias)[number]) => s.inicio?.slice(0, 7) : (s: (typeof ferias)[number]) => s.status;
    return {
      ...corte,
      feriasNoPeriodo: ferias.length,
      emFeriasHoje: ferias.filter((s) => s.status === 'aprovada' && s.inicio! <= hoje && (s.fim ?? s.inicio!) >= hoje).length,
      porStatus: contar(ferias, (s) => s.status),
      ...(a.agruparPor ? { agrupado: contar(ferias, chave) } : {}),
      periodosVencidos: vencidas.length,
      periodosAVencerAteOFim: aVencer.length,
      coletivas: 'erro' in col ? col : col.itens.filter((x) => sobrepoe(x.inicio, x.fim, inicio, fim)),
      itens: ferias.slice(0, max),
      vencidas: vencidas.slice(0, max),
      aVencer: aVencer.slice(0, max),
    };
  });
  const ok = Object.values(porUnidade).filter((u): u is Extract<typeof u, { ok: true }> => u.ok);
  return {
    periodo: { inicio, fim, hoje },
    ...(contas.length > 1
      ? { rede: { feriasNoPeriodo: ok.reduce((s, u) => s + u.feriasNoPeriodo, 0), periodosVencidos: ok.reduce((s, u) => s + u.periodosVencidos, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: Object.entries(porUnidade).filter(([, u]) => u.ok && 'truncado' in u && u.truncado).map(([s]) => s) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- convenia_afastamentos

async function afastamentosDe(ctx: ContextoConvenia, c: ContaConvenia, id: string): Promise<Afastamento[]> {
  return comCache(ctx, `afast|${c.slug}|${id}`, TTL.busca, async () => {
    const r = await c.fonte.get<{ data?: { absences?: AfastamentoBruto[] | null } | null }>(`/employees/${encodeURIComponent(id)}/absences`);
    return (r?.data?.absences ?? []).map(afastamentoSeguro);
  });
}

const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1;

export async function conveniaAfastamentos(
  ctx: ContextoConvenia,
  a: { unidade: string | string[]; inicio: string; fim: string; departamento?: string; cargo?: string; busca?: string; motivo?: string; agruparPor?: 'motivo' | 'tipo' | 'departamento' | 'colaborador' | 'mes'; maxItens?: number },
) {
  validarData(a.inicio, 'inicio');
  validarData(a.fim, 'fim');
  if (a.fim < a.inicio) throw new ErroDeEntrada('fim antes do início');
  const contas = resolverContasConvenia(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 100 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const { lidos, corte } = await alvosAtivos(ctx, c, a);
    const listas = await emParalelo(lidos, 4, async (p) => (await afastamentosDe(ctx, c, p.id)).map((x) => ({ nome: p.nome, cargo: p.cargo, departamento: p.departamento, ...x })));
    const itens = listas
      .flat()
      .filter((x) => sobrepoe(x.de, x.ate, a.inicio, a.fim) && contem(x.motivo, a.motivo))
      .map((x) => ({ ...x, diasNoPeriodo: diasEntre(x.de! > a.inicio ? x.de! : a.inicio, (x.ate ?? x.de!) < a.fim ? (x.ate ?? x.de!) : a.fim) }))
      .sort((x, y) => String(x.de).localeCompare(String(y.de)));
    const chave: Record<string, (x: (typeof itens)[number]) => string | null | undefined> = {
      motivo: (x) => x.motivo, tipo: (x) => x.tipo, departamento: (x) => x.departamento, colaborador: (x) => x.nome, mes: (x) => x.de?.slice(0, 7),
    };
    return {
      ...corte,
      ocorrencias: itens.length,
      pessoas: new Set(itens.map((x) => x.nome)).size,
      diasNoPeriodo: itens.reduce((s, x) => s + x.diasNoPeriodo, 0),
      porMotivo: contar(itens, (x) => x.motivo),
      ...(a.agruparPor ? { agrupado: contar(itens, chave[a.agruparPor]!) } : {}),
      itens: itens.slice(0, max),
    };
  });
  const ok = Object.values(porUnidade).filter((u): u is Extract<typeof u, { ok: true }> => u.ok);
  return {
    periodo: { inicio: a.inicio, fim: a.fim },
    observacao: 'Só de quem está ativo hoje. Motivo e tipo vêm do Convênia; CID e justificativa não saem por este conector.',
    ...(contas.length > 1
      ? { rede: { ocorrencias: ok.reduce((s, u) => s + u.ocorrencias, 0), diasNoPeriodo: ok.reduce((s, u) => s + u.diasNoPeriodo, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: Object.entries(porUnidade).filter(([, u]) => u.ok && 'truncado' in u && u.truncado).map(([s]) => s) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- convenia_colaborador

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uma parte da ficha que falhou (ex. token sem a permissão de férias) não derruba o resto. */
async function parte<T>(fn: () => Promise<T>): Promise<T | { indisponivel: string }> {
  try {
    return await fn();
  } catch (e) {
    return { indisponivel: e instanceof Error ? e.message : String(e) };
  }
}

export async function conveniaColaborador(ctx: ContextoConvenia, a: { unidade: string; busca: string }) {
  const contas = resolverContasConvenia(ctx, a.unidade);
  if (contas.length !== 1) throw new ErroDeEntrada('informe UMA empresa');
  const c = contas[0]!;
  const b = a.busca.trim();
  if (b.length < 3) throw new ErroDeEntrada('busca com pelo menos 3 letras (nome) ou o id do Convênia');
  let id: string;
  if (UUID.test(b)) {
    id = b;
  } else {
    const at = await ativos(ctx, c);
    let achados: ColaboradorComSaida[] = at.itens.filter((x) => casaNome(x, b));
    if (!achados.length) achados = (await desligadosComFicha(ctx, c, () => true)).itens.filter((x) => casaNome(x, b));
    if (!achados.length) throw new ErroDeEntrada(`ninguém com "${b}" no nome entre os ativos e os desligados de ${c.slug}`);
    if (achados.length > 1) {
      return {
        unidade: c.slug,
        naoUnico: b,
        candidatos: achados.slice(0, 15).map((x) => ({ id: x.id, nome: x.nome, cargo: x.cargo, departamento: x.departamento, situacao: x.situacao })),
        comoUsar: 'chame de novo com o id (ou o nome completo) de um destes',
      };
    }
    id = achados[0]!.id;
  }
  const pessoa = await ficha(ctx, c, id);
  const saida = (await parte(() => desligados(ctx, c)));
  const desligamento = 'itens' in saida ? saida.itens.find((d) => d.id === id)?.desligamento : undefined;
  const [ferias, afastamentos] = await Promise.all([parte(() => feriasDe(ctx, c, id)), parte(() => afastamentosDe(ctx, c, id))]);
  return {
    unidade: c.slug,
    colaborador: { ...pessoa, ...(desligamento ? { situacao: 'Desligado', desligamento } : {}) },
    ferias,
    afastamentos,
    lgpd: 'CPF, RG, PIS, conta bancária, endereço, telefones, e-mails, salário, nascimento, dados de saúde (CID, ASO, deficiência) e anotações não saem por este conector.',
  };
}

// ----------------------------------------------------------------- ferramentas

const unidade = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('empresa: slug ou nome curto ("doutor-digital"), uma lista, ou "todas" (até 10). Veja listar_integracoes.');
const umaUnidade = z.string().min(1).describe('empresa: slug ou nome curto ("doutor-digital")');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);
const LGPD =
  ' Por LGPD, NÃO devolve CPF, RG, PIS, CTPS, dados bancários/Pix, endereço, telefones, e-mails, salário, data de nascimento, ' +
  'dados de saúde (CID, ASO, deficiência), etnia nem anotações — só nome, cargo, departamento, time, gestor e datas.';
const filtrosPessoa = {
  departamento: z.string().optional().describe('parte do nome do departamento, sem acento'),
  cargo: z.string().optional().describe('parte do nome do cargo'),
};

export function registrarFerramentasConvenia(server: McpServer, ctx: ContextoConvenia, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'convenia_colaboradores',
    {
      title: 'Colaboradores (Convênia)',
      description:
        'Quadro de pessoal da empresa no Convênia (RH): ativos (padrão), desligados ou todos, com filtros por departamento, cargo, time, ' +
        'gestor, nome, período de admissão e de desligamento. Use agruparPor para contar (headcount por departamento, cargo, mês de ' +
        'admissão, tipo de desligamento…) em vez de listar.' + LGPD,
      inputSchema: {
        unidade,
        situacao: z.enum(['ativos', 'desligados', 'todos']).optional().describe('padrão: ativos (ou desligados, se vier período de desligamento)'),
        ...filtrosPessoa,
        time: z.string().optional(),
        gestor: z.string().optional().describe('parte do nome do gestor direto'),
        busca: z.string().optional().describe('parte do nome da pessoa'),
        admitidosDe: data('admitidos a partir de').optional(),
        admitidosAte: data('admitidos até').optional(),
        desligadosDe: data('desligados a partir de').optional(),
        desligadosAte: data('desligados até').optional(),
        agruparPor: z.enum(['departamento', 'cargo', 'time', 'centroDeCusto', 'gestor', 'situacao', 'vinculo', 'mesAdmissao', 'mesDesligamento', 'tipoDesligamento']).optional(),
        maxItens: z.number().int().min(0).max(500).optional(),
      },
      annotations: ro,
    },
    (args) => executar('convenia_colaboradores', args, auditar, () => conveniaColaboradores(ctx, args)),
  );
  server.registerTool(
    'convenia_colaborador',
    {
      title: 'Ficha de um colaborador (Convênia)',
      description:
        'A ficha de UMA pessoa pelo nome (ou id do Convênia): cargo, departamento, time, gestor, vínculo (CLT, estágio…), admissão, ' +
        'fim do contrato de experiência ou do estágio, desligamento, férias (períodos com saldo e limite para tirar, solicitações) e ' +
        'faltas/afastamentos (motivo e datas). Nome que casa com mais de uma pessoa devolve só os candidatos.' + LGPD,
      inputSchema: { unidade: umaUnidade, busca: z.string().min(3).describe('nome (ou parte) ou id do Convênia') },
      annotations: ro,
    },
    (args) => executar('convenia_colaborador', args, auditar, () => conveniaColaborador(ctx, args)),
  );
  server.registerTool(
    'convenia_movimentacao',
    {
      title: 'Admissões e desligamentos (Convênia)',
      description:
        'Admissões e desligamentos no período (data de admissão / data do desligamento): quantidades, saldo, por mês, por tipo de ' +
        'desligamento e por departamento, ativos hoje, e a lista com nome, cargo e departamento.' + LGPD,
      inputSchema: { unidade, inicio: data('início'), fim: data('fim'), ...filtrosPessoa, maxItens: z.number().int().min(0).max(500).optional() },
      annotations: ro,
    },
    (args) => executar('convenia_movimentacao', args, auditar, () => conveniaMovimentacao(ctx, args)),
  );
  server.registerTool(
    'convenia_ferias',
    {
      title: 'Férias (Convênia)',
      description:
        'Férias no período (padrão: de hoje a 90 dias): quem sai e volta quando, status das solicitações, quem está de férias hoje, ' +
        'férias coletivas, e os períodos com saldo VENCIDOS (limite para tirar já passou — risco de pagar em dobro) ou a vencer até o ' +
        'fim do período. Lê uma pessoa por vez (até 40 por chamada): numa empresa grande, filtre por departamento.' + LGPD,
      inputSchema: {
        unidade, inicio: data('início').optional(), fim: data('fim').optional(), ...filtrosPessoa,
        busca: z.string().optional().describe('parte do nome da pessoa'),
        agruparPor: z.enum(['status', 'departamento', 'mes']).optional(),
        maxItens: z.number().int().min(0).max(500).optional(),
      },
      annotations: ro,
    },
    (args) => executar('convenia_ferias', args, auditar, () => conveniaFerias(ctx, args)),
  );
  server.registerTool(
    'convenia_afastamentos',
    {
      title: 'Faltas e afastamentos (Convênia)',
      description:
        'Faltas, licenças e afastamentos no período, de quem está ativo: motivo (falta, doença, acidente, maternidade…), tipo ' +
        '(justificada ou não), datas, dias dentro do período, por motivo. NUNCA devolve o CID nem a justificativa escrita. Lê uma ' +
        'pessoa por vez (até 40 por chamada): numa empresa grande, filtre por departamento.' + LGPD,
      inputSchema: {
        unidade, inicio: data('início'), fim: data('fim'), ...filtrosPessoa,
        busca: z.string().optional().describe('parte do nome da pessoa'),
        motivo: z.string().optional().describe('parte do motivo, ex. "doença"'),
        agruparPor: z.enum(['motivo', 'tipo', 'departamento', 'colaborador', 'mes']).optional(),
        maxItens: z.number().int().min(0).max(500).optional(),
      },
      annotations: ro,
    },
    (args) => executar('convenia_afastamentos', args, auditar, () => conveniaAfastamentos(ctx, args)),
  );
}
