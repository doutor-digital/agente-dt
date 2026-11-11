/**
 * Onde as ferramentas `banco_*` tocam um banco de verdade.
 *
 *  - `fonteDoAgente`: SQL direto (Prisma) no banco do próprio agente-dt. Cliente PRÓPRIO (poucas conexões), para uma consulta pesada da
 *    Suzanne não tirar conexão da Sofia. Por padrão usa a DATABASE_URL; MCP_BANCO_AGENTE_URL aponta para outro papel (ex.: um usuário
 *    com permissão só nas tabelas que se quer abrir).
 *  - `fonteDoSistema`: RH e Descontratos pela API de administração do sistema (a mesma do `sistemas_consultar`): só leitura; o servidor
 *    dele já roda a consulta em transação READ ONLY, com 10 s e 1.000 linhas.
 *
 * Toda transação direta começa com: SET LOCAL statement_timeout = 30 s, lock_timeout = 5 s, search_path = public e standard_conforming_strings = on. A leitura ainda ganha
 * SET LOCAL transaction_read_only = on — e o SQL do usuário não consegue desligar isso (SET e set_config são recusados antes, banco-sql.ts).
 */
import { PrismaClient } from '@prisma/client';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { criarCatalogo, type Catalogo, type TabelaCat } from './banco-sql.js';
import { ESQUEMAS_DE_SISTEMA } from './banco-segredos.js';
import { ErroDeBanco, type FonteBanco, type TxBanco } from './banco.js';
import { resolverSistema, type ContextoSistemas } from './sistemas.js';

export const TIMEOUT_MS = 30_000;

/** "Raw query failed. Code: `42601`. Message: `ERROR: …`" → "(42601) ERROR: …", só o que o Postgres disse. */
export function mensagemDoBanco(e: unknown): string {
  const t = (e instanceof Error ? e.message : String(e)).trim();
  const m = /Message: `([\s\S]*?)`\s*$/.exec(t);
  const codigo = /Code: `([^`]+)`/.exec(t)?.[1];
  return `${codigo ? `(${codigo}) ` : ''}${m?.[1] ?? t}`.replace(/\s+/g, ' ').slice(0, 400);
}

class Desfazer extends Error {}

/** Só o que o Prisma oferece e a gente usa: dá para trocar por um falso nos testes. */
export interface ClienteSql {
  $transaction<T>(fn: (tx: ClienteSql) => Promise<T>, o?: { maxWait?: number; timeout?: number }): Promise<T>;
  $queryRawUnsafe<T = unknown>(sql: string, ...params: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
}

export const SQL_COLUNAS = `SELECT c.relname AS tabela, c.relkind::text AS tipo, c.reltuples::bigint AS linhas, a.attname AS coluna,
  COALESCE(i.indisprimary AND a.attnum = ANY (i.indkey), false) AS chave,
  (a.attgenerated <> '' OR a.attidentity = 'a') AS gerada
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
ORDER BY c.relname, a.attnum`;

/** quem é filha de quem por FK que apaga/zera junto (ON DELETE CASCADE, SET NULL, SET DEFAULT) */
export const SQL_CASCATAS = `SELECT p.relname AS pai, f.relname AS filha
FROM pg_constraint c
JOIN pg_class p ON p.oid = c.confrelid
JOIN pg_class f ON f.oid = c.conrelid
JOIN pg_namespace n ON n.oid = p.relnamespace
WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n', 'd') AND n.nspname = 'public'`;

export function catalogoDeLinhas(
  colunas: Array<Record<string, unknown>>,
  esquemas: Array<Record<string, unknown>>,
  funcoes: Array<Record<string, unknown>>,
  cascatas: Array<Record<string, unknown>> = [],
): Catalogo {
  const por = new Map<string, TabelaCat>();
  for (const l of colunas) {
    const nome = String(l.tabela);
    let t = por.get(nome);
    if (!t) {
      t = { nome, colunas: [], chave: [], visao: l.tipo === 'v' || l.tipo === 'm', linhas: l.linhas === null || l.linhas === undefined || Number(l.linhas) < 0 ? null : Number(l.linhas) };
      por.set(nome, t);
    }
    t.colunas.push(String(l.coluna));
    if (l.chave === true) t.chave.push(String(l.coluna));
    if (l.gerada === true) t.geradas = [...(t.geradas ?? []), String(l.coluna)];
  }
  for (const c of cascatas) {
    const pai = por.get(String(c.pai));
    if (pai) pai.cascata = [...new Set([...(pai.cascata ?? []), String(c.filha)])];
  }
  return criarCatalogo([...por.values()], esquemas.map((e) => String(e.nspname)), funcoes.map((f) => String(f.proname)));
}

export function fonteComCliente(cliente: ClienteSql): FonteBanco {
  async function transacao<T>(fn: (tx: TxBanco) => Promise<T>, o: { desfazer?: boolean; leitura?: boolean } = {}): Promise<T> {
    let resultado: T | undefined;
    try {
      await cliente.$transaction(
        async (tx) => {
          // uma ida só ao banco; `true` = vale só até o fim desta transação. standard_conforming_strings: texto comum nunca trata a barra como escape (o analisador conta com isso)
          await tx.$queryRawUnsafe(
            `SELECT set_config('statement_timeout', '${TIMEOUT_MS}', true), set_config('lock_timeout', '5000', true), set_config('search_path', 'public', true), set_config('standard_conforming_strings', 'on', true), set_config('transaction_read_only', '${o.leitura ? 'on' : 'off'}', true)`,
          );
          resultado = await fn({
            consultar: (sql, ...params) => tx.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params),
            executar: (sql, ...params) => tx.$executeRawUnsafe(sql, ...params),
          });
          if (o.desfazer) throw new Desfazer();
        },
        { maxWait: 5_000, timeout: TIMEOUT_MS + 15_000 },
      );
    } catch (e) {
      if (e instanceof Desfazer) return resultado as T;
      if (e instanceof ErroDeEntrada) throw e;
      throw new ErroDeBanco(`o banco recusou o comando ou perdeu a conexão: ${mensagemDoBanco(e)}`);
    }
    return resultado as T;
  }
  // leitura = READ ONLY e sempre ROLLBACK
  const leitura = <T>(fn: (tx: TxBanco) => Promise<T>) => transacao(fn, { leitura: true, desfazer: true });
  return {
    id: 'agente',
    escreve: true,
    linhasEmJson: true,
    cacheCatalogoMs: 0, // o catálogo é lido de novo a cada chamada: tabela nova com coluna de segredo ganha o invólucro na hora
    ler: (sql) => leitura((tx) => tx.consultar(sql)),
    catalogo: () =>
      leitura(async (tx) =>
        catalogoDeLinhas(
          await tx.consultar(SQL_COLUNAS),
          await tx.consultar("SELECT nspname FROM pg_namespace WHERE nspname <> 'public'"),
          await tx.consultar("SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')"),
          await tx.consultar(SQL_CASCATAS),
        ),
      ),
    // a escrita nunca é READ ONLY; `leitura` não é pedida de fora
    transacao: (fn, o) => transacao(fn, { desfazer: o?.desfazer }),
  };
}

/** Banco do próprio agente-dt, com cliente próprio de poucas conexões (criado na primeira chamada). */
export function fonteDoAgente(e: NodeJS.ProcessEnv = process.env): FonteBanco | null {
  const base = (e.MCP_BANCO_AGENTE_URL ?? e.DATABASE_URL ?? '').trim();
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  url.searchParams.set('connection_limit', e.MCP_BANCO_CONEXOES?.trim() || '2');
  url.searchParams.set('pool_timeout', '10');
  let cliente: PrismaClient | undefined;
  const c = () => (cliente ??= new PrismaClient({ datasourceUrl: url.toString(), log: ['error'] }));
  return fonteComCliente({
    $transaction: (fn, o) => c().$transaction((tx) => fn(tx as unknown as ClienteSql), o),
    $queryRawUnsafe: (sql, ...p) => c().$queryRawUnsafe(sql, ...p),
    $executeRawUnsafe: (sql, ...p) => c().$executeRawUnsafe(sql, ...p),
  });
}

// ------------------------------------------------------------------ RH e Descontratos (pela API do sistema)

export function fonteDoSistema(id: 'rh' | 'dsc', ctx: ContextoSistemas): FonteBanco {
  const conta = () => resolverSistema(ctx, id === 'dsc' ? 'descontratos' : undefined, id === 'dsc' ? 'dsc' : 'rh');
  return {
    id,
    escreve: false,
    linhasEmJson: false,
    cacheCatalogoMs: 0, // idem: um segredo novo no esquema do sistema ganha o invólucro na hora (custa uma chamada /esquema a mais por consulta)
    async catalogo() {
      const r = (await conta().fonte.chamar('GET', '/admin/v1/esquema')) as { tabelas?: Array<{ nome?: unknown; colunas?: Array<{ nome?: unknown }>; view?: unknown; linhas?: unknown }>; funcoes?: Array<{ nome?: unknown }> };
      const tabelas: TabelaCat[] = (r.tabelas ?? []).flatMap((t) =>
        typeof t.nome === 'string' ? [{ nome: t.nome, colunas: (t.colunas ?? []).map((c) => String(c.nome)), chave: [], visao: t.view === true, linhas: typeof t.linhas === 'number' ? t.linhas : null }] : [],
      );
      return criarCatalogo(tabelas, ESQUEMAS_DE_SISTEMA, (r.funcoes ?? []).map((f) => String(f.nome)));
    },
    async ler(sql, quem) {
      const r = (await conta().fonte.chamar('POST', '/admin/v1/consulta', { corpo: { sql }, quem })) as { linhas?: Array<Record<string, unknown>> };
      return Array.isArray(r.linhas) ? r.linhas : [];
    },
    transacao: () => Promise.reject(new ErroDeEntrada(`o banco ${id} é lido pela API do sistema: sem escrita por SQL`)),
  };
}

