/**
 * O estado do servidor (unidades, clientes, cache, contador) e o "rodar em cada unidade"
 * que todas as ferramentas usam.
 */
import { ClienteSpine, type OpcoesCliente } from './cliente.js';
import type { Unidade } from './unidade.js';
import { Cache, Contador, emParalelo, Orcamento, Ritmo } from './ritmo.js';
import { ErroDeEntrada } from './travas.js';

export interface OpcoesContexto {
  /** intervalo mínimo entre duas requisições do mesmo token */
  intervaloMs?: number;
  /** páginas por consulta (cada página tem até 100 registros) */
  tetoPaginas?: number;
  /** requisições por chamada de ferramenta, somando todas as unidades */
  tetoRequisicoes?: number;
  /** unidades consultadas ao mesmo tempo */
  paralelo?: number;
  cliente?: Omit<OpcoesCliente, 'ritmo' | 'contador'>;
  agora?: () => number;
}

export interface Contexto {
  unidades: Map<string, Unidade>;
  clientes: Map<string, ClienteSpine>;
  cache: Cache;
  contador: Contador;
  ritmo: Ritmo;
  opcoesCliente: Omit<OpcoesCliente, 'ritmo' | 'contador'>;
  tetoPaginas: number;
  tetoRequisicoes: number;
  paralelo: number;
}

export function criarContexto(unidades: Map<string, Unidade>, op: OpcoesContexto = {}): Contexto {
  const ctx: Contexto = {
    unidades: new Map(),
    clientes: new Map(),
    cache: new Cache(op.agora),
    contador: new Contador(),
    ritmo: new Ritmo(op.intervaloMs ?? 1_000, op.cliente?.dormir, op.agora),
    opcoesCliente: op.cliente ?? {},
    tetoPaginas: op.tetoPaginas ?? 20,
    tetoRequisicoes: op.tetoRequisicoes ?? 200,
    paralelo: op.paralelo ?? 3,
  };
  trocarUnidades(ctx, unidades);
  return ctx;
}

/**
 * Troca a lista de unidades (token novo, unidade nova) mantendo o ritmo, o contador e o cache:
 * o ritmo é por token, então duas listas seguidas nunca disparam rajada no mesmo token.
 */
export function trocarUnidades(ctx: Contexto, unidades: Map<string, Unidade>): void {
  const clientes = new Map<string, ClienteSpine>();
  for (const u of unidades.values()) {
    clientes.set(u.slug, new ClienteSpine(u, { ...ctx.opcoesCliente, ritmo: ctx.ritmo, contador: ctx.contador }));
  }
  ctx.unidades = unidades;
  ctx.clientes = clientes;
}

/** `"serra"`, `["serra","taubate"]` ou `"todas"`. Slug desconhecido é erro, com a lista dos válidos. */
export function resolverUnidades(ctx: Contexto, alvo: string | string[]): Unidade[] {
  if (ctx.unidades.size === 0) {
    throw new ErroDeEntrada('nenhuma unidade disponível agora (a lista ainda está carregando, ou nenhuma tem token). Tente em instantes.');
  }
  const pedidos = (Array.isArray(alvo) ? alvo : [alvo]).map((s) => s.trim().toLowerCase());
  if (pedidos.includes('todas')) return [...ctx.unidades.values()];
  const achadas = new Map<string, Unidade>();
  const desconhecidas: string[] = [];
  for (const pedido of pedidos) {
    const u = acharUnidade(ctx, pedido);
    if (u) achadas.set(u.slug, u);
    else desconhecidas.push(pedido);
  }
  if (desconhecidas.length) {
    throw new ErroDeEntrada(
      `unidade desconhecida ou ambígua: ${desconhecidas.join(', ')}. Válidas: ${[...ctx.unidades.keys()].join(', ')}, ou "todas"`,
    );
  }
  return [...achadas.values()];
}

/**
 * Slug exato, ou nome curto: "serra" acha "doutor-hernia-serra" (slug que termina em "-serra").
 * Só vale se UMA unidade casar — "dois resultados" é pergunta, não resposta.
 */
function acharUnidade(ctx: Contexto, pedido: string): Unidade | undefined {
  const exata = ctx.unidades.get(pedido);
  if (exata) return exata;
  if (!pedido) return undefined;
  const candidatas = [...ctx.unidades.values()].filter((u) => u.slug.endsWith(`-${pedido}`));
  return candidatas.length === 1 ? candidatas[0] : undefined;
}

/**
 * O teto da chamada dividido em COTAS IGUAIS por unidade. Com um bolo só, as primeiras unidades a
 * rodar gastavam tudo e as últimas falhavam na 1ª página — quem ficava de fora dependia da ordem.
 * Com cota, cada unidade lê até a sua parte e, se não couber, sai marcada como `truncado`.
 */
export class Cotas {
  private dadas: Orcamento[] = [];
  constructor(readonly porUnidade: number) {}

  nova(): Orcamento {
    const o = new Orcamento(this.porUnidade);
    this.dadas.push(o);
    return o;
  }

  get usadas(): number {
    return this.dadas.reduce((n, o) => n + o.usadas, 0);
  }
}

/**
 * Recusa ANTES de começar se a cota de cada unidade não cobre nem 1 requisição por fatia.
 * Páginas não dá pra prever: essas são cortadas pela cota e marcadas como `truncado`.
 */
export function conferirTamanho(ctx: Contexto, unidades: number, fatias: number): Cotas {
  const porUnidade = Math.floor(ctx.tetoRequisicoes / Math.max(1, unidades));
  if (fatias > porUnidade) {
    throw new ErroDeEntrada(
      `esse pedido faria pelo menos ${unidades * fatias} requisições à franquia (limite ${ctx.tetoRequisicoes} por chamada, ` +
        `${porUnidade} por unidade). Peça menos unidades ou um período menor.`,
    );
  }
  return new Cotas(porUnidade);
}

export type ResultadoUnidade = ({ ok: true } & Record<string, unknown>) | { ok: false; erro: string };

/**
 * Roda `fn` em cada unidade (no máximo `ctx.paralelo` ao mesmo tempo). Uma unidade que falha
 * vira `{ ok: false, erro }` e NÃO derruba as outras — o relatório da rede mostra quem ficou de fora
 * em vez de devolver um total silenciosamente menor.
 */
export async function porUnidade(
  ctx: Contexto,
  unidades: Unidade[],
  fn: (u: Unidade, cliente: ClienteSpine) => Promise<Record<string, unknown>>,
): Promise<Record<string, ResultadoUnidade>> {
  const resultados = await emParalelo(unidades, ctx.paralelo, async (u): Promise<[string, ResultadoUnidade]> => {
    try {
      return [u.slug, { ok: true, ...(await fn(u, ctx.clientes.get(u.slug) as ClienteSpine)) }];
    } catch (e) {
      return [u.slug, { ok: false, erro: e instanceof Error ? e.message : String(e) }];
    }
  });
  return Object.fromEntries(resultados);
}

/**
 * Lê do cache ou executa e guarda. Falha não entra no cache, e leitura INCOMPLETA (`truncado`)
 * também não: senão um pedido menor, que caberia inteiro, recebe a sobra do pedido grande.
 */
export async function comCache<T extends object>(
  ctx: Contexto,
  chave: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ valor: T; doCache: boolean }> {
  const guardado = ctx.cache.pegar<T>(chave);
  if (guardado !== undefined) return { valor: guardado, doCache: true };
  const valor = await fn();
  if (!(valor as { truncado?: unknown }).truncado) ctx.cache.guardar(chave, valor, ttlMs);
  return { valor, doCache: false };
}
