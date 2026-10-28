/**
 * Asaas no conector: cobranças, extrato, saldo e clientes das clínicas com a chave do Asaas no painel de
 * integrações. Aqui é só leitura — a fonte de produção é o `asaasGet` (só GET). Cadastrar cliente e gerar
 * boleto existem à parte, em dois passos, em `asaas-escrita.ts`. Nos testes, uma fonte falsa.
 *
 * O extrato é o que ENTROU de verdade (não o comprovante que o paciente manda): é por ele que se confere
 * se um Pix caiu.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { Cache, TTL } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';

export interface FonteAsaas {
  get<T>(caminho: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

/** A porta de escrita da conta: só cadastrar cliente e gerar cobrança (ver `lib/integracoes/asaas-escrita.ts`). */
export interface EscritaAsaas {
  post<T>(caminho: '/customers' | '/payments', corpo: Record<string, unknown>): Promise<T>;
  /** Os 4 últimos caracteres da chave, para mostrar em QUAL conta vai gravar. Nunca a chave. */
  chaveFinal: string;
  /** Nome da conta que o Asaas devolveu quando a chave foi salva no painel de integrações. */
  contaSalva?: string | null;
}

export interface ContaAsaas {
  slug: string;
  nome: string;
  fonte: FonteAsaas;
  /** Sem isto a conta é só leitura. */
  escrita?: EscritaAsaas;
}

export interface ContextoAsaas {
  contas: Map<string, ContaAsaas>;
  cache: Cache;
  /** páginas de 100 por consulta */
  maxPaginas: number;
}

export function criarContextoAsaas(contas: Map<string, ContaAsaas>, op: { maxPaginas?: number; agora?: () => number } = {}): ContextoAsaas {
  return { contas, cache: new Cache(op.agora), maxPaginas: op.maxPaginas ?? 30 };
}

export const MAX_CONTAS_ASAAS = 10;

export function resolverContasAsaas(ctx: ContextoAsaas, alvo: string | string[]): ContaAsaas[] {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma clínica com o Asaas ligado ainda (cadastre a chave no painel de integrações).');
  const pedidos = Array.isArray(alvo) ? alvo : [alvo];
  if (pedidos.some((p) => p.trim().toLowerCase() === 'todas')) {
    if (ctx.contas.size > MAX_CONTAS_ASAAS) throw new ErroDeEntrada(`peça até ${MAX_CONTAS_ASAAS} clínicas por vez. Com Asaas: ${[...ctx.contas.keys()].join(', ')}`);
    return [...ctx.contas.values()];
  }
  const achadas: ContaAsaas[] = [];
  const faltam: string[] = [];
  for (const p of pedidos) {
    const slug = acharSlug(ctx.contas.keys(), p);
    if (slug) achadas.push(ctx.contas.get(slug)!);
    else faltam.push(p);
  }
  if (faltam.length) throw new ErroDeEntrada(`clínica sem Asaas, desconhecida ou ambígua: ${faltam.join(', ')}. Com Asaas: ${[...ctx.contas.keys()].join(', ')}`);
  if (achadas.length > MAX_CONTAS_ASAAS) throw new ErroDeEntrada(`no máximo ${MAX_CONTAS_ASAAS} clínicas por chamada`);
  return achadas;
}

async function comCache<T>(ctx: ContextoAsaas, chave: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const g = ctx.cache.pegar<T>(chave);
  if (g !== undefined) return g;
  const v = await fn();
  if (!(v as { truncado?: unknown })?.truncado) ctx.cache.guardar(chave, v, ttl);
  return v;
}

/** Listagem do Asaas (offset/limit 100, `hasMore`), com teto de páginas. */
async function paginar<T>(ctx: ContextoAsaas, c: ContaAsaas, caminho: string, query: Record<string, string | number | undefined>): Promise<{ itens: T[]; truncado: boolean }> {
  const itens: T[] = [];
  for (let p = 0; p < ctx.maxPaginas; p++) {
    const r = await c.fonte.get<{ data?: T[]; hasMore?: boolean }>(caminho, { ...query, offset: p * 100, limit: 100 });
    itens.push(...(r?.data ?? []));
    if (!r?.hasMore) return { itens, truncado: false };
  }
  return { itens, truncado: true };
}

function periodo(inicio: string, fim: string): void {
  validarData(inicio, 'inicio');
  validarData(fim, 'fim');
  if (fim < inicio) throw new ErroDeEntrada('fim antes do início');
}

const reais = (n: number) => Math.round(n * 100) / 100;

/** Em cada clínica, isolada: uma com erro não derruba as outras; "rede" soma só as que responderam. */
async function emCada<T extends object>(contas: ContaAsaas[], fn: (c: ContaAsaas) => Promise<T>) {
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

// ----------------------------------------------------------------- cobranças

const STATUS: Record<string, string> = {
  PENDING: 'aguardando pagamento', RECEIVED: 'recebida', CONFIRMED: 'confirmada', OVERDUE: 'vencida', REFUNDED: 'estornada',
  RECEIVED_IN_CASH: 'recebida em dinheiro', REFUND_REQUESTED: 'estorno solicitado', REFUND_IN_PROGRESS: 'estorno em andamento',
  CHARGEBACK_REQUESTED: 'chargeback', CHARGEBACK_DISPUTE: 'chargeback em disputa', AWAITING_CHARGEBACK_REVERSAL: 'aguardando reversão',
  DUNNING_REQUESTED: 'em negativação', DUNNING_RECEIVED: 'recuperada', AWAITING_RISK_ANALYSIS: 'em análise de risco',
};
const PAGAS = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'DUNNING_RECEIVED']);
const FORMA: Record<string, string> = { PIX: 'Pix', BOLETO: 'boleto', CREDIT_CARD: 'cartão', UNDEFINED: 'a escolher' };

interface Cobranca {
  id: string;
  customer?: string;
  value?: number;
  netValue?: number;
  status?: string;
  billingType?: string;
  dueDate?: string;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  dateCreated?: string;
  description?: string | null;
}

const CAMPO_DATA = { vencimento: 'dueDate', pagamento: 'paymentDate', criacao: 'dateCreated' } as const;

export function resumirCobrancas(itens: Cobranca[], agruparPor?: 'status' | 'forma' | 'dia' | 'mes', campoData: keyof Cobranca = 'dueDate') {
  const somar = (chave: (c: Cobranca) => string) => {
    const out: Record<string, { quantidade: number; valor: number }> = {};
    for (const c of itens) {
      const o = (out[chave(c) || '(vazio)'] ??= { quantidade: 0, valor: 0 });
      o.quantidade += 1;
      o.valor = reais(o.valor + (Number(c.value) || 0));
    }
    return out;
  };
  const pagas = itens.filter((c) => PAGAS.has(c.status ?? ''));
  const abertas = itens.filter((c) => c.status === 'PENDING');
  const vencidas = itens.filter((c) => c.status === 'OVERDUE');
  const total = (xs: Cobranca[], k: 'value' | 'netValue' = 'value') => reais(xs.reduce((s, c) => s + (Number(c[k]) || 0), 0));
  const data = (c: Cobranca) => String(c[campoData] ?? '').slice(0, 10);
  return {
    cobrancas: itens.length,
    valor: total(itens),
    recebidas: { quantidade: pagas.length, valor: total(pagas), liquido: total(pagas, 'netValue') },
    aguardando: { quantidade: abertas.length, valor: total(abertas) },
    vencidas: { quantidade: vencidas.length, valor: total(vencidas) },
    porStatus: somar((c) => STATUS[c.status ?? ''] ?? c.status ?? ''),
    porForma: somar((c) => FORMA[c.billingType ?? ''] ?? c.billingType ?? ''),
    ...(agruparPor === 'dia' ? { agrupado: somar(data) } : agruparPor === 'mes' ? { agrupado: somar((c) => data(c).slice(0, 7)) } : {}),
  };
}

export async function asaasCobrancas(
  ctx: ContextoAsaas,
  a: { unidade: string | string[]; inicio: string; fim: string; data?: 'vencimento' | 'pagamento' | 'criacao'; status?: string; forma?: 'PIX' | 'BOLETO' | 'CREDIT_CARD'; agruparPor?: 'status' | 'forma' | 'dia' | 'mes'; maxItens?: number },
) {
  periodo(a.inicio, a.fim);
  const contas = resolverContasAsaas(ctx, a.unidade);
  const campo = CAMPO_DATA[a.data ?? 'vencimento'];
  const max = a.maxItens ?? (contas.length === 1 ? 30 : 0);
  const porUnidade = await emCada(contas, async (c) => {
    const q = { [`${campo}[ge]`]: a.inicio, [`${campo}[le]`]: a.fim, status: a.status, billingType: a.forma };
    const { itens, truncado } = await comCache(ctx, `cob|${c.slug}|${JSON.stringify(q)}`, TTL.busca, () => paginar<Cobranca>(ctx, c, '/payments', q));
    return {
      ...resumirCobrancas(itens, a.agruparPor, campo as keyof Cobranca),
      truncado,
      itens: itens.slice(0, max).map((x) => ({
        vencimento: x.dueDate, pagamento: x.clientPaymentDate ?? x.paymentDate ?? null, valor: x.value, liquido: x.netValue,
        status: STATUS[x.status ?? ''] ?? x.status, forma: FORMA[x.billingType ?? ''] ?? x.billingType, descricao: x.description ?? null,
      })),
    };
  });
  const ok = Object.values(porUnidade).filter((u): u is Extract<typeof u, { ok: true }> => u.ok);
  return {
    periodo: { inicio: a.inicio, fim: a.fim, data: a.data ?? 'vencimento' },
    ...(contas.length > 1
      ? { rede: {
          cobrancas: ok.reduce((s, u) => s + u.cobrancas, 0),
          valor: reais(ok.reduce((s, u) => s + u.valor, 0)),
          recebidas: reais(ok.reduce((s, u) => s + u.recebidas.valor, 0)),
          vencidas: reais(ok.reduce((s, u) => s + u.vencidas.valor, 0)),
          unidadesForaDoTotal: Object.entries(porUnidade).filter(([, u]) => !u.ok).map(([s]) => s),
        } }
      : {}),
    porUnidade,
  };
}

// ----------------------------------------------------------------- extrato

interface Lancamento {
  id: string;
  value?: number;
  balance?: number;
  type?: string;
  date?: string;
  description?: string | null;
  paymentId?: string | null;
}

export function resumirExtrato(itens: Lancamento[]) {
  const ordenados = [...itens].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const entradas = itens.filter((l) => (Number(l.value) || 0) > 0);
  const saidas = itens.filter((l) => (Number(l.value) || 0) < 0);
  const porTipo: Record<string, { quantidade: number; valor: number }> = {};
  for (const l of itens) {
    const o = (porTipo[l.type ?? '(sem tipo)'] ??= { quantidade: 0, valor: 0 });
    o.quantidade += 1;
    o.valor = reais(o.valor + (Number(l.value) || 0));
  }
  const ultimo = ordenados[ordenados.length - 1];
  return {
    lancamentos: itens.length,
    entradas: { quantidade: entradas.length, valor: reais(entradas.reduce((s, l) => s + Number(l.value), 0)) },
    saidas: { quantidade: saidas.length, valor: reais(saidas.reduce((s, l) => s + Number(l.value), 0)) },
    saldoNoFim: ultimo?.balance ?? null,
    porTipo,
  };
}

export async function asaasExtrato(ctx: ContextoAsaas, a: { unidade: string; inicio: string; fim: string; maxItens?: number }) {
  periodo(a.inicio, a.fim);
  const [c] = resolverContasAsaas(ctx, a.unidade);
  const { itens, truncado } = await comCache(ctx, `ext|${c!.slug}|${a.inicio}|${a.fim}`, TTL.busca, () =>
    paginar<Lancamento>(ctx, c!, '/financialTransactions', { startDate: a.inicio, finishDate: a.fim, order: 'asc' }),
  );
  return {
    unidade: c!.slug,
    periodo: { inicio: a.inicio, fim: a.fim },
    ...resumirExtrato(itens),
    truncado,
    itens: itens.slice(0, a.maxItens ?? 50).map((l) => ({ data: l.date, valor: l.value, saldo: l.balance, tipo: l.type, descricao: l.description ?? null })),
  };
}

// ----------------------------------------------------------------- saldo e clientes

export async function asaasSaldo(ctx: ContextoAsaas, a: { unidade: string | string[] }) {
  const contas = resolverContasAsaas(ctx, a.unidade);
  const porUnidade = await emCada(contas, async (c) => ({ saldo: (await c.fonte.get<{ balance?: number }>('/finance/balance'))?.balance ?? null }));
  return { consultadoEm: new Date().toISOString(), porUnidade };
}

export async function asaasCliente(ctx: ContextoAsaas, a: { unidade: string; busca: string }) {
  const [c] = resolverContasAsaas(ctx, a.unidade);
  const b = a.busca.trim();
  if (b.length < 3) throw new ErroDeEntrada('busca com pelo menos 3 letras ou números');
  const doc = b.replace(/\D/g, '');
  const q = doc.length === 11 || doc.length === 14 ? { cpfCnpj: doc } : { name: b };
  const r = await c!.fonte.get<{ data?: Array<{ id: string; name?: string; cpfCnpj?: string; mobilePhone?: string; phone?: string; email?: string }> }>('/customers', { ...q, limit: 20 });
  return { unidade: c!.slug, clientes: (r?.data ?? []).map((x) => ({ id: x.id, nome: x.name ?? null, documento: x.cpfCnpj ?? null, celular: x.mobilePhone || x.phone || null, email: x.email ?? null })) };
}

// ----------------------------------------------------------------- ferramentas

const unidade = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe('clínica: slug ou nome curto ("serra"), uma lista, ou "todas" (até 10). Veja listar_integracoes.');
const umaUnidade = z.string().min(1).describe('clínica: slug ou nome curto ("serra")');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);

export function registrarFerramentasAsaas(server: McpServer, ctx: ContextoAsaas, auditar?: Auditar): void {
  server.registerTool(
    'asaas_cobrancas',
    {
      title: 'Cobranças (Asaas)',
      description:
        'Cobranças do Asaas no período, por data de vencimento (padrão), pagamento ou criação: recebidas (bruto e líquido), aguardando, ' +
        'vencidas, por status e por forma (Pix, boleto, cartão). Filtra por status (PENDING, RECEIVED, CONFIRMED, OVERDUE…) e forma.',
      inputSchema: {
        unidade, inicio: data('início'), fim: data('fim'),
        data: z.enum(['vencimento', 'pagamento', 'criacao']).optional(),
        status: z.string().optional(),
        forma: z.enum(['PIX', 'BOLETO', 'CREDIT_CARD']).optional(),
        agruparPor: z.enum(['status', 'forma', 'dia', 'mes']).optional(),
        maxItens: z.number().int().min(0).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('asaas_cobrancas', args, auditar, () => asaasCobrancas(ctx, args)),
  );
  server.registerTool(
    'asaas_extrato',
    {
      title: 'Extrato (Asaas)',
      description:
        'Extrato da conta Asaas da clínica: cada entrada e saída de dinheiro no período, com o saldo. É a fonte para conferir se um Pix ' +
        'ou boleto caiu de verdade (comprovante enviado por paciente não prova).',
      inputSchema: { unidade: umaUnidade, inicio: data('início'), fim: data('fim'), maxItens: z.number().int().min(0).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('asaas_extrato', args, auditar, () => asaasExtrato(ctx, args)),
  );
  server.registerTool(
    'asaas_saldo',
    {
      title: 'Saldo (Asaas)',
      description: 'Saldo atual da conta Asaas de cada clínica.',
      inputSchema: { unidade },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('asaas_saldo', args, auditar, () => asaasSaldo(ctx, args)),
  );
  server.registerTool(
    'asaas_cliente',
    {
      title: 'Buscar cliente (Asaas)',
      description: 'Busca um cliente no Asaas da clínica pelo nome ou CPF/CNPJ.',
      inputSchema: { unidade: umaUnidade, busca: z.string().min(3) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('asaas_cliente', args, auditar, () => asaasCliente(ctx, args)),
  );
}
