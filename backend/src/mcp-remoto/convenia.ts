/**
 * Convênia no conector: colaboradores, admissões e desligamentos, férias e afastamentos das empresas com o
 * token do Convênia no painel de integrações. Só leitura — a fonte de produção é o `conveniaGet` (só GET).
 *
 * Dado pessoal: por decisão da dona da empresa (24/10/2026), o conector NÃO corta mais campo nenhum — sai o
 * que o Convênia manda, CPF, salário, dados bancários, endereço, nascimento, etnia, deficiência, ASO, CID e
 * anotações incluídos. Cada registro ganha os nomes em português que o filtro e o agrupamento usam e leva o
 * registro cru junto. Nas listagens de pessoal a resposta vem resumida (só os campos em português) para não
 * estourar o tamanho; `completo: true` devolve a ficha inteira, e `convenia_colaborador` já vem completa.
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

/** Um colaborador como a API devolve. O que não está declarado aqui chega pela index signature e também sai. */
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
const nomeDe = (n?: unknown, s?: unknown): string | null => texto([texto(n), texto(s)].filter(Boolean).join(' '));
export const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Os campos com nome em português — é por eles que filtro, agrupamento, busca e ordenação funcionam, e são
 * eles (e só eles) que o `resumirColaborador` projeta nas listagens.
 */
export interface ColaboradorEmPortugues {
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

/** Os campos em português MAIS o registro cru do Convênia (index signature): nada é cortado. */
export interface Colaborador extends ColaboradorEmPortugues {
  [extra: string]: unknown;
}

/**
 * O colaborador como o Convênia manda (CPF, RG, PIS, CTPS, conta e Pix, endereço, telefones, e-mails,
 * salário, nascimento, etnia, deficiência, ASO, anotações, dependentes… tudo) mais os nomes em português
 * que o filtro e o agrupamento usam — e que, vindo depois no spread, ganham do bruto em caso de choque.
 * Liberado por decisão da dona da empresa em 24/10/2026.
 */
export function colaboradorNormalizado(c: ColaboradorBruto): Colaborador {
  const nome = nomeDe(c.name, c.last_name) ?? '(sem nome)';
  const social = texto(c.social_name);
  const vinculo = texto(c.relationship?.name);
  const exp = c.experience_period;
  const experiencia = exp && (dia(exp.first_end) || dia(exp.second_end))
    ? { tipo: texto(exp.experience_period_type), fimPrimeiroPeriodo: dia(exp.first_end), fimSegundoPeriodo: dia(exp.second_end) }
    : null;
  const estagio = c.intern && (dia(c.intern.initial_at) || dia(c.intern.finish_at)) ? { inicio: dia(c.intern.initial_at), fim: dia(c.intern.finish_at) } : null;
  return {
    ...c,
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

export interface DesligamentoEmPortugues {
  data: string | null;
  tipo: string | null;
  avisoPrevio: string | null;
  etapa: string | null;
}

export interface Desligamento extends DesligamentoEmPortugues {
  [extra: string]: unknown;
}

export type DesligadoNormalizado = { id: string; desligamento: Desligamento; [extra: string]: unknown };

/** Desligamento inteiro: data, tipo, aviso prévio, etapa e também motivo, comentários e e-mail corporativo. */
export function desligamentoNormalizado(d: DesligadoBruto): DesligadoNormalizado {
  const x = d.dismissal ?? {};
  return {
    ...d,
    id: String(d.id),
    desligamento: {
      ...x,
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
  [extra: string]: unknown;
}

/**
 * Único normalizador que reescreve uma chave do bruto (`status`: "approved" → "aprovada"), porque o filtro
 * de cancelada/recusada depende disso — então o valor original sai em `statusOriginal` e nada se perde.
 */
export function solicitacaoNormalizada(s: SolicitacaoBruta): Ferias {
  const st = String(s.status ?? '').toLowerCase();
  return {
    ...s,
    inicio: dia(s.starts_at),
    fim: dia(s.finishes_at),
    dias: typeof s.requested_days === 'number' ? s.requested_days : null,
    abonoDias: typeof s.allowance === 'number' && s.allowance > 0 ? s.allowance : null,
    statusOriginal: texto(s.status),
    status: s.canceled ? 'cancelada' : (STATUS_FERIAS[st] ?? (st || 'sem status')),
  };
}

export interface PeriodoAquisitivo {
  aquisitivo: { inicio: string | null; fim: string | null };
  saldoDias: number | null;
  /** fim do período concessivo: depois dele, férias não tiradas são pagas em dobro */
  limiteParaTirar: string | null;
  [extra: string]: unknown;
}

export function periodoNormalizado(p: PeriodoBruto): PeriodoAquisitivo {
  return {
    ...p,
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
  [extra: string]: unknown;
}

/** Afastamento inteiro: motivo e tipo com nome em português e o registro cru, CID e justificativa inclusive. */
export function afastamentoNormalizado(a: AfastamentoBruto): Afastamento {
  const total = Number(a.total);
  return {
    ...a,
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

/** Ativos normalizados: o cache guarda a ficha COMPLETA; quem resume é a resposta, não o cache. */
async function ativos(ctx: ContextoConvenia, c: ContaConvenia): Promise<{ itens: Colaborador[]; truncado: boolean }> {
  return comCache(ctx, `ativos|${c.slug}`, TTL.busca, async () => {
    const { itens, truncado } = await paginar<ColaboradorBruto>(ctx, c, '/employees');
    return { itens: itens.map(colaboradorNormalizado).sort(porNome), truncado };
  });
}

async function desligados(ctx: ContextoConvenia, c: ContaConvenia): Promise<{ itens: DesligadoNormalizado[]; truncado: boolean }> {
  return comCache(ctx, `desligados|${c.slug}`, TTL.busca, async () => {
    const { itens, truncado } = await paginar<DesligadoBruto>(ctx, c, '/employees/dismissed', 1000);
    return { itens: itens.map(desligamentoNormalizado), truncado };
  });
}

async function ficha(ctx: ContextoConvenia, c: ContaConvenia, id: string, ttl = TTL.busca): Promise<Colaborador> {
  return comCache(ctx, `ficha|${c.slug}|${id}`, ttl, async () => {
    const r = await c.fonte.get<{ data?: ColaboradorBruto | null }>(`/employees/${encodeURIComponent(id)}`);
    if (!r?.data) throw new ErroDeEntrada(`colaborador ${id} não encontrado no Convênia`);
    return colaboradorNormalizado(r.data);
  });
}

export type ColaboradorComSaida = Colaborador & { desligamento?: Desligamento };
/** O mesmo sem o registro cru: a ficha de pessoa é grande e nas listagens a resposta sai assim por padrão. */
export type ColaboradorResumido = ColaboradorEmPortugues & { desligamento?: Desligamento };

/**
 * PROJETA os campos em português de uma ficha já normalizada (não remonta nada: o que não está aqui
 * continua no registro, e `completo: true` devolve ele inteiro).
 */
export function resumirColaborador(c: ColaboradorComSaida): ColaboradorResumido {
  return {
    id: c.id,
    nome: c.nome,
    ...(c.nomeSocial !== undefined ? { nomeSocial: c.nomeSocial } : {}),
    situacao: c.situacao,
    admissao: c.admissao,
    matricula: c.matricula,
    departamento: c.departamento,
    cargo: c.cargo,
    time: c.time,
    centroDeCusto: c.centroDeCusto,
    gestor: c.gestor,
    ...(c.vinculo !== undefined ? { vinculo: c.vinculo } : {}),
    ...(c.experiencia !== undefined ? { experiencia: c.experiencia } : {}),
    ...(c.estagio !== undefined ? { estagio: c.estagio } : {}),
    ...(c.desligamento !== undefined ? { desligamento: c.desligamento } : {}),
  };
}

/** A lista de pessoas de uma resposta: resumida por padrão, a ficha inteira do Convênia com `completo`. */
const itensDePessoa = (xs: ColaboradorComSaida[], completo?: boolean): Array<ColaboradorComSaida | ColaboradorResumido> =>
  completo ? xs : xs.map(resumirColaborador);

/**
 * Desligados que passam no `filtro`, com a ficha (nome, cargo, departamento, admissão) lida uma a uma — a
 * listagem de desligados do Convênia só traz o id e o desligamento. Mais recentes primeiro; além do teto,
 * ficam sem ficha (`semFicha`: só id e desligamento — dá para CONTAR, não para nomear nem filtrar por pessoa).
 */
async function desligadosComFicha(
  ctx: ContextoConvenia,
  c: ContaConvenia,
  filtro: (d: Desligamento) => boolean,
): Promise<{ itens: ColaboradorComSaida[]; truncado: boolean; semFicha: DesligadoNormalizado[] }> {
  const { itens, truncado } = await desligados(ctx, c);
  const alvo = itens.filter((d) => filtro(d.desligamento)).sort((a, b) => String(b.desligamento.data).localeCompare(String(a.desligamento.data)));
  const lidos = alvo.slice(0, ctx.maxColaboradores);
  const fichas = await emParalelo(lidos, 4, async (d) => {
    const f = await ficha(ctx, c, d.id, TTL_DESLIGADO);
    // quem tem desligamento é carimbado "Desligado", mas a ficha pode ainda dizer "Ativo" (aviso prévio
    // correndo): com o registro cru saindo junto, as duas versões apareceriam sem dizer qual vale
    return { ...f, situacaoOriginal: f.situacao, situacao: 'Desligado', desligamento: d.desligamento };
  });
  return { itens: fichas, truncado, semFicha: alvo.slice(lidos.length) };
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
const incompletas = (porUnidade: Record<string, { ok: boolean }>) =>
  Object.entries(porUnidade).filter(([, u]) => u.ok && ('incompleto' in u || 'truncado' in u)).map(([s]) => s);

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
        ? { truncado: true, incompleto: true, aviso: `li ${lidos.length} de ${filtrados.length} pessoas (o Convênia aceita 50 chamadas por minuto): filtre por departamento ou cargo para ver o resto` }
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
  /** `true` devolve a ficha inteira de cada pessoa; ausente devolve o resumo em português. */
  completo?: boolean;
}

/** Agrupamentos que a listagem de desligados responde sozinha (sem a ficha da pessoa). */
const SEM_FICHA_RESPONDE = new Set<AgruparColaboradores>(['situacao', 'mesDesligamento', 'tipoDesligamento']);

export async function conveniaColaboradores(ctx: ContextoConvenia, a: ArgsColaboradores) {
  periodo(a.admitidosDe, a.admitidosAte, 'admitidos');
  periodo(a.desligadosDe, a.desligadosAte, 'desligados');
  const situacao = a.situacao ?? (a.desligadosDe || a.desligadosAte ? 'desligados' : 'ativos');
  if (situacao === 'ativos' && (a.desligadosDe || a.desligadosAte)) throw new ErroDeEntrada('desligadosDe/desligadosAte pedem situacao "desligados" ou "todos"');
  const contas = resolverContasConvenia(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 50 : 0);
  // filtro que só a ficha responde: quem ficou sem ficha não entra e a conta fica incompleta
  const filtroDePessoa = !!(a.departamento || a.cargo || a.time || a.gestor || a.busca || a.admitidosDe || a.admitidosAte);
  const porUnidade = await emCada(contas, async (c) => {
    const lista = new Map<string, ColaboradorComSaida>();
    let truncado = false;
    let semFicha: DesligadoNormalizado[] = [];
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
      semFicha = r.semFicha.filter((d) => !lista.has(d.id));
    }
    const filtrados = [...lista.values()].filter((x) => passa(x, a) && noPeriodo(x.admissao, a.admitidosDe, a.admitidosAte));
    // sem filtro de pessoa, quem ficou sem ficha ainda CONTA (a listagem traz o desligamento); só não é nomeado
    const contados = filtroDePessoa ? 0 : semFicha.length;
    const grupo = a.agruparPor;
    const agrupado = grupo
      ? contar(
          [...filtrados.map((x) => CHAVE_GRUPO[grupo](x)), ...semFicha.slice(0, contados).map((d) => (SEM_FICHA_RESPONDE.has(grupo) ? CHAVE_GRUPO[grupo]({ situacao: 'Desligado', desligamento: d.desligamento } as ColaboradorComSaida) : '(sem ficha)'))],
          (k) => k,
        )
      : undefined;
    const incompleto = truncado || (semFicha.length > 0 && filtroDePessoa);
    const avisos = [
      ...(truncado ? ['a listagem do Convênia passou do teto de páginas: os números são parciais'] : []),
      ...(semFicha.length && filtroDePessoa ? [`${semFicha.length} desligados não tiveram a ficha lida e ficaram FORA do filtro (os números são parciais): estreite o período de desligamento`] : []),
      ...(semFicha.length && !filtroDePessoa ? [`${semFicha.length} desligados entram na contagem sem nome (ficha não lida, teto de ${ctx.maxColaboradores} por chamada): estreite o período de desligamento para ver quem são`] : []),
    ];
    return {
      total: filtrados.length + contados,
      ...(situacao === 'todos' ? { ativos: filtrados.filter((x) => !x.desligamento).length, desligados: filtrados.filter((x) => x.desligamento).length + contados } : {}),
      ...(agrupado ? { agrupado } : {}),
      ...(incompleto ? { incompleto: true } : {}),
      ...(semFicha.length ? { desligadosSemFicha: semFicha.length } : {}),
      ...(avisos.length ? { aviso: avisos.join(' · ') } : {}),
      itens: itensDePessoa(filtrados.slice(0, max), a.completo),
    };
  });
  const ok = Object.values(porUnidade).filter((u): u is Extract<typeof u, { ok: true }> => u.ok);
  return {
    situacao,
    ...(contas.length > 1
      ? { rede: { colaboradores: ok.reduce((s, u) => s + u.total, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- convenia_movimentacao

export async function conveniaMovimentacao(
  ctx: ContextoConvenia,
  a: { unidade: string | string[]; inicio: string; fim: string; departamento?: string; cargo?: string; maxItens?: number; completo?: boolean },
) {
  validarData(a.inicio, 'inicio');
  validarData(a.fim, 'fim');
  if (a.fim < a.inicio) throw new ErroDeEntrada('fim antes do início');
  const contas = resolverContasConvenia(ctx, a.unidade);
  const max = a.maxItens ?? (contas.length === 1 ? 50 : 0);
  const filtro = { departamento: a.departamento, cargo: a.cargo };
  const comFiltro = !!(a.departamento || a.cargo);
  const porUnidade = await emCada(contas, async (c) => {
    const at = await ativos(ctx, c);
    // quem saiu a partir do início pode ter entrado no período: a ficha traz a admissão
    const de = await desligadosComFicha(ctx, c, (d) => !!d.data && d.data >= a.inicio);
    const ids = new Set(at.itens.map((x) => x.id));
    const todos: ColaboradorComSaida[] = [...at.itens, ...de.itens.filter((x) => !ids.has(x.id))].filter((x) => passa(x, filtro));
    const admitidos = todos.filter((x) => noPeriodo(x.admissao, a.inicio, a.fim)).sort((x, y) => String(x.admissao).localeCompare(String(y.admissao)));
    const noPer = (d?: Desligamento) => noPeriodo(d?.data ?? null, a.inicio, a.fim);
    const saidasComFicha = de.itens.filter((x) => passa(x, filtro) && noPer(x.desligamento)).sort((x, y) => String(x.desligamento?.data).localeCompare(String(y.desligamento?.data)));
    // sem filtro de pessoa, a CONTAGEM de desligamentos vem da listagem inteira (não depende da ficha)
    const saidasContadas: Desligamento[] = comFiltro
      ? saidasComFicha.map((x) => x.desligamento!)
      : [...saidasComFicha.map((x) => x.desligamento!), ...de.semFicha.filter((d) => noPer(d.desligamento)).map((d) => d.desligamento)];
    const porMes: Record<string, { admissoes: number; desligamentos: number }> = {};
    for (const x of admitidos) (porMes[x.admissao!.slice(0, 7)] ??= { admissoes: 0, desligamentos: 0 }).admissoes++;
    for (const d of saidasContadas) (porMes[d.data!.slice(0, 7)] ??= { admissoes: 0, desligamentos: 0 }).desligamentos++;
    const semFicha = de.semFicha.length;
    const avisos = [
      ...(at.truncado || de.truncado ? ['a listagem do Convênia passou do teto de páginas: os números são parciais'] : []),
      ...(semFicha
        ? [comFiltro
            ? `${semFicha} desligados desde ${a.inicio} não tiveram a ficha lida: admissões e desligamentos deste filtro podem estar faltando — estreite o período`
            : `${semFicha} desligados desde ${a.inicio} não tiveram a ficha lida: a contagem de desligamentos está completa, mas admissões de quem já saiu e a divisão por departamento podem faltar — estreite o período`]
        : []),
    ];
    return {
      ativosHoje: at.itens.filter((x) => passa(x, filtro)).length,
      admissoes: admitidos.length,
      desligamentos: saidasContadas.length,
      saldo: admitidos.length - saidasContadas.length,
      porMes: Object.fromEntries(Object.entries(porMes).sort(([x], [y]) => x.localeCompare(y))),
      desligamentosPorTipo: contar(saidasContadas, (d) => d.tipo),
      desligamentosPorDepartamento: contar(saidasComFicha, (x) => x.departamento),
      admissoesPorDepartamento: contar(admitidos, (x) => x.departamento),
      ...(avisos.length ? { incompleto: true, aviso: avisos.join(' · ') } : {}),
      ...(semFicha ? { desligadosSemFicha: semFicha } : {}),
      itensAdmissoes: itensDePessoa(admitidos.slice(0, max), a.completo),
      itensDesligamentos: itensDePessoa(saidasComFicha.slice(0, max), a.completo),
    };
  });
  const ok = Object.values(porUnidade).filter((u): u is Extract<typeof u, { ok: true }> => u.ok);
  return {
    periodo: { inicio: a.inicio, fim: a.fim },
    ...(contas.length > 1
      ? { rede: { admissoes: ok.reduce((s, u) => s + u.admissoes, 0), desligamentos: ok.reduce((s, u) => s + u.desligamentos, 0), ativosHoje: ok.reduce((s, u) => s + u.ativosHoje, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
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
    return { solicitacoes: (s?.data ?? []).map(solicitacaoNormalizada), periodos: (p?.data ?? []).map(periodoNormalizado) };
  });
}

async function coletivas(ctx: ContextoConvenia, c: ContaConvenia) {
  return comCache(ctx, `coletivas|${c.slug}`, TTL.busca, async () => {
    const { itens, truncado } = await paginar<ColetivaBruta>(ctx, c, '/companies/collective-vacations', 200);
    return {
      truncado,
      itens: itens.map((x) => ({
        ...x,
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

/** Férias e períodos saem inteiros; o tipo precisa dizer isso (o spread sozinho perde a index signature). */
type FeriasDePessoa = Ferias & { nome: string; cargo: string | null; departamento: string | null };
type PeriodoDePessoa = PeriodoAquisitivo & { limiteParaTirar: string; nome: string; departamento: string | null };

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
    // a solicitação e o período saem inteiros; nome/cargo/departamento vêm DEPOIS do spread para que um
    // campo do Convênia com o mesmo nome não troque a pessoa (nem o departamento que agrupa)
    const ferias = fichas
      .flatMap(({ p, f }) => f.solicitacoes.map((s): FeriasDePessoa => ({ ...s, nome: p.nome, cargo: p.cargo, departamento: p.departamento })))
      .filter((s) => s.status !== 'cancelada' && s.status !== 'recusada' && sobrepoe(s.inicio, s.fim, inicio, fim))
      .sort((x, y) => String(x.inicio).localeCompare(String(y.inicio)));
    const comSaldo = fichas.flatMap(({ p, f }) =>
      f.periodos
        .filter((x) => (x.saldoDias ?? 0) > 0 && x.limiteParaTirar)
        .map((x): PeriodoDePessoa => ({ ...x, limiteParaTirar: x.limiteParaTirar!, nome: p.nome, departamento: p.departamento })),
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
      ? { rede: { feriasNoPeriodo: ok.reduce((s, u) => s + u.feriasNoPeriodo, 0), periodosVencidos: ok.reduce((s, u) => s + u.periodosVencidos, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- convenia_afastamentos

async function afastamentosDe(ctx: ContextoConvenia, c: ContaConvenia, id: string): Promise<Afastamento[]> {
  return comCache(ctx, `afast|${c.slug}|${id}`, TTL.busca, async () => {
    const r = await c.fonte.get<{ data?: { absences?: AfastamentoBruto[] | null } | null }>(`/employees/${encodeURIComponent(id)}/absences`);
    return (r?.data?.absences ?? []).map(afastamentoNormalizado);
  });
}

const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1;

/** O afastamento sai inteiro; o tipo precisa dizer isso (o spread sozinho perde a index signature). */
type AfastamentoDePessoa = Afastamento & { nome: string; cargo: string | null; departamento: string | null };
type AfastamentoNoPeriodo = AfastamentoDePessoa & { diasNoPeriodo: number };

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
    // o afastamento sai inteiro (CID e justificativa inclusive); nome/cargo/departamento vêm DEPOIS do
    // spread para que um campo do Convênia com o mesmo nome não troque a pessoa nem o agrupamento
    const listas = await emParalelo(lidos, 4, async (p) =>
      (await afastamentosDe(ctx, c, p.id)).map((x): AfastamentoDePessoa => ({ ...x, nome: p.nome, cargo: p.cargo, departamento: p.departamento })),
    );
    const itens = listas
      .flat()
      .filter((x) => sobrepoe(x.de, x.ate, a.inicio, a.fim) && contem(x.motivo, a.motivo))
      .map((x): AfastamentoNoPeriodo => ({ ...x, diasNoPeriodo: diasEntre(x.de! > a.inicio ? x.de! : a.inicio, (x.ate ?? x.de!) < a.fim ? (x.ate ?? x.de!) : a.fim) }))
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
    observacao: 'Só de quem está ativo hoje. O registro vem como o Convênia guarda, CID e justificativa inclusive — é dado de saúde: use para o que foi pedido e não repasse.',
    ...(contas.length > 1
      ? { rede: { ocorrencias: ok.reduce((s, u) => s + u.ocorrencias, 0), diasNoPeriodo: ok.reduce((s, u) => s + u.diasNoPeriodo, 0), unidadesForaDoTotal: foraDoTotal(porUnidade), unidadesIncompletas: incompletas(porUnidade) } }
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
    let naoLidos = 0;
    if (!achados.length) {
      const de = await desligadosComFicha(ctx, c, () => true);
      achados = de.itens.filter((x) => casaNome(x, b));
      naoLidos = de.semFicha.length;
    }
    if (!achados.length) {
      const resto = naoLidos ? ` (os ${naoLidos} desligamentos mais antigos não foram lidos: procure com convenia_colaboradores situacao="desligados" e um período de desligamento)` : '';
      throw new ErroDeEntrada(`ninguém com "${b}" no nome entre os ativos e os desligados de ${c.slug}${resto}`);
    }
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
  // mesmo carimbo de `desligadosComFicha`: `situacaoOriginal` guarda o que a ficha dizia (ver lá). O tipo é
  // anotado porque o spread sozinho perde a index signature e passaria a esconder o registro cru.
  const colaborador: ColaboradorComSaida = { ...pessoa, ...(desligamento ? { situacaoOriginal: pessoa.situacao, situacao: 'Desligado', desligamento } : {}) };
  return {
    unidade: c.slug,
    colaborador,
    ferias,
    afastamentos,
    aviso: 'Ficha completa do Convênia: pode trazer CPF, RG, PIS, CTPS, dados bancários/Pix, endereço, telefones, e-mails, salário, nascimento, etnia, deficiência e dados de saúde (CID, ASO). É dado pessoal sensível, a consulta fica registrada: responda o que foi pedido e não repasse o resto.',
  };
}

// ----------------------------------------------------------------- ferramentas

const unidade = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('empresa: slug ou nome curto ("doutor-digital"), uma lista, ou "todas" (até 10). Veja listar_integracoes.');
const umaUnidade = z.string().min(1).describe('empresa: slug ou nome curto ("doutor-digital")');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);
/** Aviso factual: o conector não corta campo nenhum (decisão da dona da empresa, 24/10/2026). */
const AVISO_DADO_PESSOAL =
  ' A resposta pode trazer dado pessoal sensível como o Convênia guarda (CPF, RG, PIS, CTPS, dados bancários/Pix, endereço, ' +
  'telefones, e-mails, salário, nascimento, etnia, deficiência, dados de saúde como CID e ASO, anotações) e a consulta fica registrada.';
const filtrosPessoa = {
  departamento: z.string().optional().describe('parte do nome do departamento, sem acento'),
  cargo: z.string().optional().describe('parte do nome do cargo'),
};
const completo = z
  .boolean()
  .optional()
  .describe(
    'true traz a ficha INTEIRA de cada pessoa (CPF, salário, dados bancários, endereço, nascimento, dados de saúde), como a ' +
      'LISTAGEM do Convênia a devolve — se algum campo faltar, convenia_colaborador lê a ficha individual daquela pessoa. ' +
      'Padrão (ausente): resumo com nome, situação, matrícula, cargo, departamento, time, centro de custo, gestor, vínculo e datas. ' +
      'A ficha inteira é grande: use com filtro ou maxItens pequeno, senão a resposta não cabe na conversa.',
  );

export function registrarFerramentasConvenia(server: McpServer, ctx: ContextoConvenia, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'convenia_colaboradores',
    {
      title: 'Colaboradores (Convênia)',
      description:
        'Quadro de pessoal da empresa no Convênia (RH): ativos (padrão), desligados ou todos, com filtros por departamento, cargo, time, ' +
        'gestor, nome, período de admissão e de desligamento. Use agruparPor para contar (headcount por departamento, cargo, mês de ' +
        'admissão, tipo de desligamento…) em vez de listar. A lista vem resumida; completo: true traz a ficha inteira de cada ' +
        'pessoa.' + AVISO_DADO_PESSOAL,
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
        completo,
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
        'faltas/afastamentos (motivo, CID, datas). Vem SEMPRE completa, como o Convênia guarda — não precisa de flag. Nome que ' +
        'casa com mais de uma pessoa devolve só os candidatos.' + AVISO_DADO_PESSOAL,
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
        'desligamento e por departamento, ativos hoje, e a lista resumida de quem entrou e de quem saiu (completo: true traz a ' +
        'ficha inteira de cada um).' + AVISO_DADO_PESSOAL,
      inputSchema: { unidade, inicio: data('início'), fim: data('fim'), ...filtrosPessoa, maxItens: z.number().int().min(0).max(500).optional(), completo },
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
        'fim do período. Solicitações e períodos saem como o Convênia guarda. Lê uma pessoa por vez (até 40 por chamada): numa ' +
        'empresa grande, filtre por departamento.' + AVISO_DADO_PESSOAL,
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
        '(justificada ou não), datas, dias dentro do período, por motivo. O registro sai inteiro, CID e justificativa escrita ' +
        'inclusive. Lê uma pessoa por vez (até 40 por chamada): numa empresa grande, filtre por departamento.' + AVISO_DADO_PESSOAL,
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
