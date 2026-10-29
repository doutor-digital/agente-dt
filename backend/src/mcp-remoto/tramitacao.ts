/**
 * Tramitação Inteligente no conector: processos, publicações, clientes e atividades do escritório de advocacia
 * com a chave do escritório no painel de integrações (provedor `tramitacao`). Só leitura — a fonte de produção
 * é o `tramitacaoGet` (só GET, só nas rotas da lista dele).
 *
 * Regras que não mudam com nenhuma flag:
 *  - documentos de processo saem como METADADOS (tipo, data, páginas, tamanho, situação). Texto e arquivo do
 *    documento não são lidos: o cliente HTTP nem tem a rota;
 *  - a senha do Meu INSS do cliente nunca é pedida à API nem devolvida; dados bancários do cliente também não;
 *  - CPF e telefone saem mascarados, em qualquer campo. `completo: true` devolve o registro da API, mas já limpo.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { Cache } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { tramitacaoGet } from '../lib/integracoes/tramitacao.js';
import { limparRegistro, mascararCelula, mascararTexto, normalizarCabecalho } from '../lib/integracoes/mascaras.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';

type Query = Record<string, string | number | boolean | undefined | Array<string | number>>;

export interface FonteTramitacao {
  get<T>(caminho: string, query?: Query): Promise<T>;
}

export interface ContaTramitacao {
  slug: string;
  nome: string;
  fonte: FonteTramitacao;
}

export interface ContextoTramitacao {
  contas: Map<string, ContaTramitacao>;
  cache: Cache;
  /** páginas de 100 lidas na busca de cliente por nome (a API não filtra por nome) */
  maxPaginas: number;
}

export function criarContextoTramitacao(contas: Map<string, ContaTramitacao>, op: { maxPaginas?: number; agora?: () => number } = {}): ContextoTramitacao {
  return { contas, cache: new Cache(op.agora), maxPaginas: op.maxPaginas ?? 5 };
}

/** A conta de uma unidade a partir da chave decifrada. A chave fica só na closure, em memória. */
export function contaTramitacaoDaChave(c: { unitId: string; slug: string; nome: string; chave: string }, get: typeof tramitacaoGet = tramitacaoGet): ContaTramitacao {
  return { slug: c.slug, nome: c.nome, fonte: { get: (caminho, query) => get(c.unitId, c.chave, caminho, query ?? {}) } };
}

export const MAX_POR_PAGINA = 100;
const POR_PAGINA = 20;

export function resolverContaTramitacao(ctx: ContextoTramitacao, unidade?: string): ContaTramitacao {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhum escritório com a Tramitação ligada ainda (cadastre a chave no painel de integrações).');
  const lista = [...ctx.contas.keys()].join(', ');
  if (!unidade?.trim()) {
    if (ctx.contas.size === 1) return [...ctx.contas.values()][0]!;
    throw new ErroDeEntrada(`informe a unidade. Com Tramitação: ${lista}`);
  }
  const slug = acharSlug(ctx.contas.keys(), unidade);
  if (!slug) throw new ErroDeEntrada(`unidade sem Tramitação, desconhecida ou ambígua: ${unidade}. Com Tramitação: ${lista}`);
  return ctx.contas.get(slug)!;
}

// ----------------------------------------------------------------- utilidades

const reais = (centavos: unknown): number | null => (typeof centavos === 'number' && Number.isFinite(centavos) ? Math.round(centavos) / 100 : null);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const nomes = (xs: unknown): string[] => (Array.isArray(xs) ? xs.map((x) => texto((x as { name?: unknown })?.name)).filter((x): x is string => !!x) : []);
const cortar = (s: string | null, n: number): { texto: string | null; cortado: boolean } =>
  s !== null && s.length > n ? { texto: `${s.slice(0, n)}…`, cortado: true } : { texto: s, cortado: false };
/** Chaves sem valor saem da query: a API recusa parâmetro vazio e o teste compara a consulta exata. */
const semVazios = (q: Query): Query => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== ''));

function tamanho(maxItens: number | undefined): number {
  const n = maxItens ?? POR_PAGINA;
  if (!Number.isInteger(n) || n < 1 || n > MAX_POR_PAGINA) throw new ErroDeEntrada(`maxItens de 1 até ${MAX_POR_PAGINA}`);
  return n;
}
function pagina(p: number | undefined): number {
  const n = p ?? 1;
  if (!Number.isInteger(n) || n < 1) throw new ErroDeEntrada('pagina deve ser 1 ou mais');
  return n;
}
function data(v: string | undefined, campo: string): string | undefined {
  return v === undefined ? undefined : validarData(v, campo);
}
function periodo(de: string | undefined, ate: string | undefined, nomeDe: string, nomeAte: string): void {
  if (de && ate && ate < de) throw new ErroDeEntrada(`${nomeAte} antes de ${nomeDe}`);
}

interface Paginacao {
  count?: number;
  page?: number;
  items?: number;
  pages?: number;
}
const paginacaoDe = (p: Paginacao | undefined, porPagina: number) => ({ pagina: p?.page ?? 1, paginas: p?.pages ?? 1, total: p?.count ?? 0, porPagina: p?.items ?? porPagina });

/** Parte da resposta que falhou (ex. 402 só em documentos) não derruba o resto. */
async function parte<T>(fn: () => Promise<T>): Promise<T | { indisponivel: string }> {
  try {
    return await fn();
  } catch (e) {
    return { indisponivel: e instanceof Error ? e.message : String(e) };
  }
}

// ----------------------------------------------------------------- processos

interface ProcessoBruto {
  id: number;
  number?: string;
  kind?: string;
  status?: string;
  court?: string | null;
  title?: string | null;
  resultado?: string | null;
  mais_detalhes?: string | null;
  ajuizamento?: string | null;
  der?: string | null;
  comarca?: string | null;
  juizo?: string | null;
  valor_da_causa_in_cents?: number | null;
  receita_prevista_in_cents?: number | null;
  numero_beneficio?: string | null;
  unidade?: string | null;
  latest_publication_date?: string | null;
  customers?: Array<{ id?: number; name?: string; role?: string | null }>;
  tags?: unknown;
  parties_count?: number;
  [outro: string]: unknown;
}

export function resumirProcesso(p: ProcessoBruto) {
  return {
    id: p.id,
    numero: texto(p.number),
    tipo: texto(p.kind),
    situacao: texto(p.status),
    tribunal: texto(p.court),
    titulo: p.title ? mascararTexto(p.title) : null,
    resultado: texto(p.resultado),
    ajuizamento: texto(p.ajuizamento),
    der: texto(p.der),
    comarca: texto(p.comarca),
    juizo: texto(p.juizo),
    valorDaCausa: reais(p.valor_da_causa_in_cents),
    receitaPrevista: reais(p.receita_prevista_in_cents),
    beneficio: texto(p.numero_beneficio),
    unidade: texto(p.unidade),
    ultimaPublicacao: texto(p.latest_publication_date),
    clientes: (p.customers ?? []).map((c) => ({ id: c.id ?? null, nome: texto(c.name), polo: texto(c.role) })),
    etiquetas: nomes(p.tags),
    partes: typeof p.parties_count === 'number' ? p.parties_count : null,
  };
}

type Resumo<T> = T & Record<string, unknown>;

const ORDEM_PROCESSOS = ['latest_publication_desc', 'latest_publication_asc', 'title_asc', 'title_desc', 'valor_da_causa_desc', 'valor_da_causa_asc'] as const;
const STATUS_PROCESSO = ['ativo', 'arquivado', 'suspenso', 'encerrado'] as const;
const TIPO_PROCESSO = ['judicial', 'administrativo', 'outro'] as const;

export interface ArgsProcessos {
  unidade?: string;
  status?: Array<(typeof STATUS_PROCESSO)[number]>;
  tipo?: (typeof TIPO_PROCESSO)[number];
  tribunal?: string;
  numero?: string;
  clienteId?: number;
  etiquetas?: string;
  ajuizamentoDe?: string;
  ajuizamentoAte?: string;
  ordenar?: (typeof ORDEM_PROCESSOS)[number];
  pagina?: number;
  maxItens?: number;
  completo?: boolean;
}

export async function tramitacaoProcessos(ctx: ContextoTramitacao, a: ArgsProcessos) {
  const por = tamanho(a.maxItens);
  const pg = pagina(a.pagina);
  if (a.numero !== undefined && !/^[\d.\-/\s]+$/.test(a.numero)) throw new ErroDeEntrada('número do processo só com dígitos e separadores (ponto, hífen, barra)');
  if (a.tribunal !== undefined && !/^[a-z0-9_]{2,12}$/i.test(a.tribunal)) throw new ErroDeEntrada('tribunal: sigla como trf3, tj_sp, trt2');
  const de = data(a.ajuizamentoDe, 'ajuizamentoDe');
  const ate = data(a.ajuizamentoAte, 'ajuizamentoAte');
  periodo(de, ate, 'ajuizamentoDe', 'ajuizamentoAte');
  const c = resolverContaTramitacao(ctx, a.unidade);
  const r = await c.fonte.get<{ lawsuits?: ProcessoBruto[]; pagination?: Paginacao }>(
    '/v1/processos',
    semVazios({
      per_page: por,
      page: pg,
      'status[]': a.status?.length ? a.status : undefined,
      'kind[]': a.tipo ? [a.tipo] : undefined,
      'court[]': a.tribunal ? [a.tribunal.toLowerCase()] : undefined,
      number: a.numero?.trim(),
      customer_id: a.clienteId,
      tags: a.etiquetas,
      ajuizamento_de: de,
      ajuizamento_ate: ate,
      order_by: a.ordenar,
    }),
  );
  const processos = (r?.lawsuits ?? []).map((p): Resumo<ReturnType<typeof resumirProcesso>> => {
    const resumo = resumirProcesso(p);
    return a.completo ? { ...limparRegistro(p), ...resumo } : resumo;
  });
  return { unidade: c.slug, paginacao: paginacaoDe(r?.pagination, por), processos };
}

// ----------------------------------------------------------------- processo (ficha)

const ID_PROCESSO = /^(?:\d+|\d[\d.\-]{12,28}\d)$/;

export interface ArgsProcesso {
  unidade?: string;
  /** id interno ou número CNJ (com ou sem máscara) */
  processo: string;
  partes?: boolean;
  movimentacoes?: boolean;
  documentos?: boolean;
  maxItens?: number;
  completo?: boolean;
}

const POLO_PUBLICACAO: Record<string, string> = { A: 'ativo', P: 'passivo' };

export async function tramitacaoProcesso(ctx: ContextoTramitacao, a: ArgsProcesso) {
  const alvo = a.processo.trim();
  if (!ID_PROCESSO.test(alvo)) throw new ErroDeEntrada('processo: informe o id interno (só dígitos) ou o número CNJ, com ou sem máscara');
  const por = tamanho(a.maxItens);
  const c = resolverContaTramitacao(ctx, a.unidade);
  const base = `/v1/processos/${encodeURIComponent(alvo)}`;
  const ficha = await c.fonte.get<{ lawsuit?: ProcessoBruto }>(base);
  if (!ficha?.lawsuit) throw new ErroDeEntrada(`processo ${alvo} não encontrado na Tramitação`);
  const bruto = ficha.lawsuit;
  const resumo = resumirProcesso(bruto);
  const [partes, movimentacoes, documentos] = await Promise.all([
    a.partes === false
      ? undefined
      : parte(async () => {
          const r = await c.fonte.get<{
            parties?: Array<{ name?: string; role?: string | null; linked?: boolean; customer?: { id?: number } | null }>;
            pagination?: Paginacao;
            counts?: Record<string, number>;
          }>(`${base}/partes`, { per_page: por, page: 1 });
          return {
            total: r?.pagination?.count ?? 0,
            contagem: r?.counts ?? null,
            itens: (r?.parties ?? []).map((p) => ({ nome: texto(p.name), polo: texto(p.role), vinculada: !!p.linked, clienteId: p.customer?.id ?? null })),
          };
        }),
    a.movimentacoes === false
      ? undefined
      : parte(async () => {
          const r = await c.fonte.get<{ movements?: Array<{ data_hora?: string | null; descricao?: string | null; tipo_nome?: string | null; grau?: string | null }>; pagination?: Paginacao }>(`${base}/movimentacoes`, {
            per_page: por,
            page: 1,
          });
          return {
            total: r?.pagination?.count ?? 0,
            itens: (r?.movements ?? []).map((m) => ({
              dataHora: texto(m.data_hora),
              tipo: texto(m.tipo_nome),
              grau: texto(m.grau),
              descricao: cortar(m.descricao ? mascararTexto(m.descricao) : null, a.completo ? 4000 : 600).texto,
            })),
          };
        }),
    a.documentos === false
      ? undefined
      : parte(async () => {
          const r = await c.fonte.get<{
            documents?: Array<{ id?: string; tipo_nome?: string | null; data_hora_juntada?: string | null; paginas?: number | null; tamanho_bytes?: number | null; status?: string }>;
            pagination?: Paginacao;
          }>(`${base}/documentos`, { per_page: por, page: 1 });
          return {
            total: r?.pagination?.count ?? 0,
            observacao: 'Só metadados: o conteúdo (texto e arquivo) dos documentos não é lido por este conector.',
            // projeção explícita: qualquer campo extra que a API passe a mandar (texto, url) não sai
            itens: (r?.documents ?? []).map((d) => ({ id: d.id ?? null, tipo: texto(d.tipo_nome), juntadaEm: texto(d.data_hora_juntada), paginas: d.paginas ?? null, tamanhoBytes: d.tamanho_bytes ?? null, status: d.status ?? null })),
          };
        }),
  ]);
  return {
    unidade: c.slug,
    processo: { ...(a.completo ? limparRegistro(bruto) : {}), ...resumo, maisDetalhes: cortar(bruto.mais_detalhes ? mascararTexto(bruto.mais_detalhes) : null, a.completo ? 4000 : 600).texto },
    ...(partes !== undefined ? { partes } : {}),
    ...(movimentacoes !== undefined ? { movimentacoes } : {}),
    ...(documentos !== undefined ? { documentos } : {}),
  };
}

// ----------------------------------------------------------------- publicações

interface PublicacaoBruta {
  id: number;
  status?: string;
  disponibilizacao_date?: string | null;
  publication_date?: string | null;
  inicio_do_prazo_date?: string | null;
  link_tramitacao?: string | null;
  texto?: string | null;
  nomeOrgao?: string | null;
  nomeClasse?: string | null;
  siglaTribunal?: string | null;
  numero_processo?: string | null;
  numero_processo_com_mascara?: string | null;
  destinatarios?: Array<{ nome?: string; polo?: string }>;
  destinatario_advogados?: Array<{ nome?: string; uf_oab?: string; numero_oab?: string }>;
}

export interface ArgsPublicacoes {
  unidade?: string;
  busca?: string;
  processoId?: number;
  tribunal?: string;
  disponibilizadasDe?: string;
  disponibilizadasAte?: string;
  /** padrão da Tramitação: nao_lida */
  situacao?: 'nao_lida' | 'tratada' | 'arquivada';
  pagina?: number;
  maxItens?: number;
  completo?: boolean;
}

export async function tramitacaoPublicacoes(ctx: ContextoTramitacao, a: ArgsPublicacoes) {
  const por = tamanho(a.maxItens);
  const pg = pagina(a.pagina);
  if (a.tribunal !== undefined && !/^[a-z0-9_]{2,12}$/i.test(a.tribunal)) throw new ErroDeEntrada('tribunal: sigla como trf3, tj_sp, trt2');
  const de = data(a.disponibilizadasDe, 'disponibilizadasDe');
  const ate = data(a.disponibilizadasAte, 'disponibilizadasAte');
  periodo(de, ate, 'disponibilizadasDe', 'disponibilizadasAte');
  const c = resolverContaTramitacao(ctx, a.unidade);
  const r = await c.fonte.get<{ publications?: PublicacaoBruta[]; pagination?: Paginacao }>(
    '/v1/publicacoes',
    semVazios({ per_page: por, page: pg, query: a.busca?.trim(), lawsuit_id: a.processoId, court: a.tribunal?.toLowerCase(), disponibilizacao_de: de, disponibilizacao_ate: ate, status: a.situacao }),
  );
  const limite = a.completo ? 8000 : 1200;
  return {
    unidade: c.slug,
    situacaoFiltrada: a.situacao ?? 'nao_lida (padrão da Tramitação: passe situacao para ver tratadas ou arquivadas)',
    paginacao: paginacaoDe(r?.pagination, por),
    publicacoes: (r?.publications ?? []).map((p) => {
      const t = cortar(p.texto ? mascararTexto(p.texto) : null, limite);
      return {
        id: p.id,
        situacao: texto(p.status),
        disponibilizacao: texto(p.disponibilizacao_date),
        publicacao: texto(p.publication_date),
        inicioDoPrazo: texto(p.inicio_do_prazo_date),
        tribunal: texto(p.siglaTribunal),
        orgao: texto(p.nomeOrgao),
        classe: texto(p.nomeClasse),
        numeroProcesso: texto(p.numero_processo_com_mascara) ?? texto(p.numero_processo),
        link: texto(p.link_tramitacao),
        destinatarios: (p.destinatarios ?? []).map((d) => ({ nome: texto(d.nome), polo: POLO_PUBLICACAO[d.polo ?? ''] ?? texto(d.polo) })),
        advogados: (p.destinatario_advogados ?? []).map((d) => ({ nome: texto(d.nome), oab: [texto(d.uf_oab), texto(d.numero_oab)].filter(Boolean).join(' ') || null })),
        texto: t.texto ?? '',
        textoCortado: t.cortado,
      };
    }),
  };
}

// ----------------------------------------------------------------- clientes

interface ClienteBruto {
  id: number;
  name?: string | null;
  customer_type?: string | null;
  cpf_cnpj?: string | null;
  email?: string | null;
  phone_mobile?: string | null;
  phone_1?: string | null;
  city?: string | null;
  state?: string | null;
  profession?: string | null;
  tags?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
  [outro: string]: unknown;
}

const mascarado = (v: unknown, cabecalho: string): string | null => {
  const t = texto(v);
  return t ? mascararCelula(t, cabecalho) : null;
};

export function resumirCliente(c: ClienteBruto) {
  return {
    id: c.id,
    nome: texto(c.name),
    tipo: texto(c.customer_type),
    cpfCnpj: mascarado(c.cpf_cnpj, 'cpf cnpj'),
    email: texto(c.email),
    celular: mascarado(c.phone_mobile, 'celular'),
    telefone: mascarado(c.phone_1, 'telefone'),
    cidade: texto(c.city),
    uf: texto(c.state),
    profissao: texto(c.profession),
    etiquetas: nomes(c.tags),
    cadastradoEm: texto(c.created_at),
    atualizadoEm: texto(c.updated_at),
  };
}

/** Registro do cliente para `completo`: sem dados bancários (a senha do Meu INSS sai em `limparRegistro`). */
function clienteCompleto(c: ClienteBruto): Record<string, unknown> {
  const { bank_accounts: _bancos, ...resto } = c;
  return limparRegistro(resto);
}

const ORDEM_CLIENTES = ['updated_at_desc', 'updated_at_asc', 'created_at_desc', 'created_at_asc', 'name_asc', 'name_desc'] as const;

export interface ArgsClientes {
  unidade?: string;
  /** CPF ou CNPJ exato, com ou sem pontuação */
  cpfCnpj?: string;
  /** a API não filtra por nome: a busca lê até `maxPaginas` páginas de 100, em ordem de nome, e filtra aqui */
  busca?: string;
  etiquetas?: string;
  cadastradosDe?: string;
  cadastradosAte?: string;
  atualizadosDe?: string;
  atualizadosAte?: string;
  ordenar?: (typeof ORDEM_CLIENTES)[number];
  pagina?: number;
  maxItens?: number;
  completo?: boolean;
}

export interface RespostaClientes {
  unidade: string;
  paginacao?: ReturnType<typeof paginacaoDe>;
  encontrados?: number;
  clientes: Array<Resumo<ReturnType<typeof resumirCliente>>>;
  truncado?: boolean;
  aviso?: string;
}

export async function tramitacaoClientes(ctx: ContextoTramitacao, a: ArgsClientes): Promise<RespostaClientes> {
  const por = tamanho(a.maxItens);
  const pg = pagina(a.pagina);
  const doc = a.cpfCnpj === undefined ? undefined : a.cpfCnpj.replace(/\D/g, '');
  if (doc !== undefined && doc.length !== 11 && doc.length !== 14) throw new ErroDeEntrada('cpfCnpj com 11 (CPF) ou 14 (CNPJ) dígitos');
  const cadDe = data(a.cadastradosDe, 'cadastradosDe');
  const cadAte = data(a.cadastradosAte, 'cadastradosAte');
  const atuDe = data(a.atualizadosDe, 'atualizadosDe');
  const atuAte = data(a.atualizadosAte, 'atualizadosAte');
  periodo(cadDe, cadAte, 'cadastradosDe', 'cadastradosAte');
  periodo(atuDe, atuAte, 'atualizadosDe', 'atualizadosAte');
  const c = resolverContaTramitacao(ctx, a.unidade);
  const filtros: Query = {
    cpf_cnpj: doc,
    tags: a.etiquetas,
    created_at_start_date: cadDe,
    created_at_end_date: cadAte,
    updated_at_start_date: atuDe,
    updated_at_end_date: atuAte,
  };
  const formatar = (x: ClienteBruto): Resumo<ReturnType<typeof resumirCliente>> => (a.completo ? { ...clienteCompleto(x), ...resumirCliente(x) } : resumirCliente(x));

  if (a.busca?.trim()) {
    const termos = normalizarCabecalho(a.busca).split(' ').filter(Boolean);
    const achados: ClienteBruto[] = [];
    let lidas = 0;
    let paginas = 1;
    for (let p = 1; p <= ctx.maxPaginas && p <= paginas; p++) {
      const r = await c.fonte.get<{ customers?: ClienteBruto[]; pagination?: Paginacao }>('/v1/clientes', semVazios({ ...filtros, per_page: MAX_POR_PAGINA, page: p, order_by: a.ordenar ?? 'name_asc' }));
      lidas = p;
      paginas = r?.pagination?.pages ?? 1;
      for (const x of r?.customers ?? []) {
        const alvo = normalizarCabecalho(String(x.name ?? ''));
        if (termos.every((t) => alvo.includes(t))) achados.push(x);
      }
      if (achados.length >= por) break;
    }
    const truncado = achados.length < por && lidas < paginas;
    return {
      unidade: c.slug,
      encontrados: Math.min(achados.length, por),
      clientes: achados.slice(0, por).map(formatar),
      ...(truncado ? { truncado: true, aviso: `a Tramitação não busca por nome: li ${lidas} de ${paginas} páginas de clientes (em ordem de nome) e o resto ficou sem ver — use cpfCnpj ou etiquetas para estreitar` } : {}),
    };
  }

  const r = await c.fonte.get<{ customers?: ClienteBruto[]; pagination?: Paginacao }>('/v1/clientes', semVazios({ ...filtros, per_page: por, page: pg, order_by: a.ordenar }));
  return {
    unidade: c.slug,
    paginacao: paginacaoDe(r?.pagination, por),
    clientes: (r?.customers ?? []).map(formatar),
  };
}

// ----------------------------------------------------------------- atividades

interface AtividadeBruta {
  id: number;
  title?: string | null;
  description?: string | null;
  type?: string | null;
  completed?: boolean;
  completed_on?: string | null;
  start?: string | null;
  end?: string | null;
  all_day?: boolean;
  amount_in_cents?: number | null;
  deadline_on?: string | null;
  deadline_days?: number | null;
  creator?: { name?: string } | null;
  customer?: { id?: number; name?: string } | null;
  lawsuit?: { id?: number; number?: string } | null;
  charge?: { status?: string; amount_in_cents?: number; due_date?: string; paid?: boolean } | null;
  users?: Array<{ name?: string; role?: string }>;
  tags?: unknown;
}

const TIPOS_ATIVIDADE = ['Task', 'Event', 'Meeting', 'Dispatch', 'Hearing', 'Deadline', 'MedicalExam', 'Income', 'Expense'] as const;

export interface ArgsAtividades {
  unidade?: string;
  processoId?: number;
  clienteId?: number;
  usuarioId?: string;
  tipo?: Array<(typeof TIPOS_ATIVIDADE)[number]>;
  concluida?: boolean;
  de?: string;
  ate?: string;
  etiquetas?: string;
  pagina?: number;
  maxItens?: number;
}

export async function tramitacaoAtividades(ctx: ContextoTramitacao, a: ArgsAtividades) {
  const por = tamanho(a.maxItens);
  const pg = pagina(a.pagina);
  const de = data(a.de, 'de');
  const ate = data(a.ate, 'ate');
  periodo(de, ate, 'de', 'ate');
  const c = resolverContaTramitacao(ctx, a.unidade);
  const r = await c.fonte.get<{ activities?: AtividadeBruta[]; pagination?: Paginacao }>(
    '/v1/atividades',
    semVazios({ per_page: por, page: pg, user_id: a.usuarioId, customer_id: a.clienteId, lawsuit_id: a.processoId, from: de, to: ate, 'type[]': a.tipo?.length ? a.tipo : undefined, completed: a.concluida, tags: a.etiquetas }),
  );
  return {
    unidade: c.slug,
    paginacao: paginacaoDe(r?.pagination, por),
    atividades: (r?.activities ?? []).map((x) => ({
      id: x.id,
      titulo: x.title ? mascararTexto(x.title) : null,
      tipo: texto(x.type),
      descricao: cortar(x.description ? mascararTexto(x.description) : null, 500).texto,
      concluida: !!x.completed,
      concluidaEm: texto(x.completed_on),
      inicio: texto(x.start),
      fim: texto(x.end),
      diaInteiro: !!x.all_day,
      prazoFatal: texto(x.deadline_on),
      prazoDias: typeof x.deadline_days === 'number' ? x.deadline_days : null,
      valor: reais(x.amount_in_cents),
      responsavel: texto(x.creator?.name),
      envolvidos: (x.users ?? []).map((u) => ({ nome: texto(u.name), papel: texto(u.role) })),
      cliente: x.customer ? { id: x.customer.id ?? null, nome: texto(x.customer.name) } : null,
      processo: x.lawsuit ? { id: x.lawsuit.id ?? null, numero: texto(x.lawsuit.number) } : null,
      cobranca: x.charge ? { status: texto(x.charge.status), valor: reais(x.charge.amount_in_cents), vencimento: texto(x.charge.due_date), paga: !!x.charge.paid } : null,
      etiquetas: nomes(x.tags),
    })),
  };
}

// ----------------------------------------------------------------- ferramentas

const unidade = z.string().min(1).optional().describe('escritório: slug ou nome curto; pode omitir se houver só um com Tramitação. Veja listar_integracoes.');
const dia = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`).optional();
const pagina_ = z.number().int().min(1).optional().describe('página (começa em 1)');
const maxItens = z.number().int().min(1).max(MAX_POR_PAGINA).optional().describe(`itens por página: padrão ${POR_PAGINA}, máximo ${MAX_POR_PAGINA}`);
const AVISO =
  ' Só leitura. CPF e telefone saem mascarados; senha do Meu INSS e dados bancários nunca saem; documentos de processo só como metadados (o conteúdo não é lido).';

export function registrarFerramentasTramitacao(server: McpServer, ctx: ContextoTramitacao, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'tramitacao_processos',
    {
      title: 'Processos (Tramitação Inteligente)',
      description:
        'Processos do escritório, mais recentes primeiro, com filtros por situação, tipo, tribunal, número, cliente, etiqueta e data de ajuizamento. ' +
        'Traz número, partes principais, valor da causa, última publicação e etiquetas. Para achar o id de um processo pelo número, filtre por numero.' +
        AVISO,
      inputSchema: {
        unidade,
        status: z.array(z.enum(STATUS_PROCESSO)).optional(),
        tipo: z.enum(TIPO_PROCESSO).optional(),
        tribunal: z.string().optional().describe('sigla em minúsculas: trf3, tj_sp, trt2'),
        numero: z.string().optional().describe('número do processo, com ou sem máscara'),
        clienteId: z.number().int().optional().describe('id do cliente na Tramitação (veja tramitacao_clientes)'),
        etiquetas: z.string().optional().describe('nomes ou ids separados por vírgula'),
        ajuizamentoDe: dia('ajuizados a partir de'),
        ajuizamentoAte: dia('ajuizados até'),
        ordenar: z.enum(ORDEM_PROCESSOS).optional(),
        pagina: pagina_,
        maxItens,
        completo: z.boolean().optional().describe('junta o registro da API (limpo de CPF, telefone e senha) ao resumo'),
      },
      annotations: ro,
    },
    (args) => executar('tramitacao_processos', args, auditar, () => tramitacaoProcessos(ctx, args)),
  );
  server.registerTool(
    'tramitacao_processo',
    {
      title: 'Um processo (Tramitação Inteligente)',
      description:
        'A ficha de UM processo (pelo id ou pelo número CNJ): dados, partes, últimas movimentações e a lista de documentos juntados ' +
        '(tipo, data, páginas, tamanho, situação).' + AVISO,
      inputSchema: {
        unidade,
        processo: z.string().min(1).describe('id interno da Tramitação ou número CNJ, com ou sem máscara'),
        partes: z.boolean().optional().describe('padrão: sim'),
        movimentacoes: z.boolean().optional().describe('padrão: sim'),
        documentos: z.boolean().optional().describe('padrão: sim (só metadados)'),
        maxItens,
        completo: z.boolean().optional(),
      },
      annotations: ro,
    },
    (args) => executar('tramitacao_processo', args, auditar, () => tramitacaoProcesso(ctx, args)),
  );
  server.registerTool(
    'tramitacao_publicacoes',
    {
      title: 'Publicações do Diário (Tramitação Inteligente)',
      description:
        'Publicações do Diário de Justiça já importadas: texto (cortado em 1200 caracteres; completo traz mais), órgão, tribunal, destinatários, ' +
        'início do prazo. ATENÇÃO: sem situacao, a Tramitação devolve só as NÃO LIDAS — passe situacao="tratada" ou "arquivada" para as outras.' + AVISO,
      inputSchema: {
        unidade,
        busca: z.string().optional().describe('número CNJ, nome de parte ou de advogado'),
        processoId: z.number().int().optional(),
        tribunal: z.string().optional(),
        disponibilizadasDe: dia('disponibilizadas a partir de'),
        disponibilizadasAte: dia('disponibilizadas até'),
        situacao: z.enum(['nao_lida', 'tratada', 'arquivada']).optional(),
        pagina: pagina_,
        maxItens,
        completo: z.boolean().optional().describe('texto da publicação até 8000 caracteres'),
      },
      annotations: ro,
    },
    (args) => executar('tramitacao_publicacoes', args, auditar, () => tramitacaoPublicacoes(ctx, args)),
  );
  server.registerTool(
    'tramitacao_clientes',
    {
      title: 'Clientes (Tramitação Inteligente)',
      description:
        'Clientes e contatos do escritório. A Tramitação não busca por nome: use cpfCnpj (exato) ou etiquetas; "busca" lê até 5 páginas de ' +
        '100 clientes em ordem de nome e filtra aqui (e avisa se não deu para ver todos).' + AVISO,
      inputSchema: {
        unidade,
        cpfCnpj: z.string().optional().describe('CPF ou CNPJ exato'),
        busca: z.string().optional().describe('parte do nome'),
        etiquetas: z.string().optional(),
        cadastradosDe: dia('cadastrados a partir de'),
        cadastradosAte: dia('cadastrados até'),
        atualizadosDe: dia('atualizados a partir de'),
        atualizadosAte: dia('atualizados até'),
        ordenar: z.enum(ORDEM_CLIENTES).optional(),
        pagina: pagina_,
        maxItens,
        completo: z.boolean().optional().describe('junta o registro da API sem senha nem dados bancários e com CPF/telefone mascarados'),
      },
      annotations: ro,
    },
    // a auditoria guarda os argumentos: o CPF buscado entra mascarado, não inteiro
    (args) => executar('tramitacao_clientes', { ...args, ...(args.cpfCnpj ? { cpfCnpj: mascararCelula(args.cpfCnpj, 'cpf cnpj') } : {}), ...(args.busca ? { busca: mascararTexto(args.busca) } : {}) }, auditar, () => tramitacaoClientes(ctx, args)),
  );
  server.registerTool(
    'tramitacao_atividades',
    {
      title: 'Atividades e prazos (Tramitação Inteligente)',
      description:
        'Atividades da agenda do escritório: tarefas, audiências, reuniões, prazos (com o prazo fatal), exames e lançamentos, ' +
        'com responsável, cliente, processo e cobrança vinculada. Filtra por processo, cliente, tipo, concluída ou não, e período.' + AVISO,
      inputSchema: {
        unidade,
        processoId: z.number().int().optional(),
        clienteId: z.number().int().optional(),
        usuarioId: z.string().optional().describe('id público do usuário (criador ou atribuído)'),
        tipo: z.array(z.enum(TIPOS_ATIVIDADE)).optional(),
        concluida: z.boolean().optional(),
        de: dia('em andamento a partir de'),
        ate: dia('que começam até'),
        etiquetas: z.string().optional(),
        pagina: pagina_,
        maxItens,
      },
      annotations: ro,
    },
    (args) => executar('tramitacao_atividades', args, auditar, () => tramitacaoAtividades(ctx, args)),
  );
}
