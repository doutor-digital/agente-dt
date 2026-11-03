/**
 * SQL livre do sistema novo (RH/Caixa) pelo claude.ai, para quem está em MCP_ESCRITA_EMAILS.
 *
 *   sistemas_sql              roda DIRETO, sem confirmação: criar tabela/view/índice/função/gatilho/política/tipo/sequência, ALTER TABLE,
 *                             COMMENT, GRANT, renomear, INSERT, UPDATE e DELETE com WHERE.
 *   sistemas_preparar_sql     DOIS passos, só para o que DESTRÓI: DROP, TRUNCATE, UPDATE/DELETE sem WHERE, apagar coluna/restrição, REVOKE,
 *   sistemas_confirmar_sql    desligar RLS. Preparar mostra o que será destruído (e quantas linhas); confirmar executa com o ok da pessoa.
 *
 * Quem decide é o PARSER DO POSTGRES (sql-regras.ts, o mesmo arquivo do servidor): nada de regex. O que nunca roda (auth, senhas, SET ROLE,
 * SECURITY DEFINER, COPY, extensões, transação manual…) é recusado aqui e de novo no servidor.
 *
 * ANTES de qualquer mudança de estrutura ou de linhas existentes o conector chama POST /admin/v1/backup (snapshot do esquema + linhas das
 * tabelas tocadas); se o backup falhar, a mudança NÃO roda. O servidor só executa com o snapshot_id desse backup, deste SQL, deste autor.
 * O registro (quem, quando, SQL inteiro, linhas afetadas) fica no admin_log do sistema, dentro da mesma transação.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { executar } from './ferramenta.js';
import { classificar, ErroSql, MAX_SQL, type AnaliseSql, type SistemaSql } from './sql-regras.js';
import { resolverSistema, tipoDaConta, VALIDADE_MS, type ContaSistemas, type ContextoSistemas, type PendentesSistemas, type QuemSistemas, type Saida } from './sistemas.js';

const MOTIVO = z.string().min(5).max(300).describe('por que — fica no registro (ex.: "tabela de preços do caixa")');
const SISTEMA = z.string().optional().describe('qual sistema: "rh" (RH/Caixa/Financeiro) ou "descontratos" (Descontratos + Ficha); pode omitir se só há um ligado');
const SQL = z.string().min(6).max(MAX_SQL).describe('um ou mais comandos SQL do Postgres, separados por ";" (até 50). Escreva tabelas em minúsculas, no esquema public.');

function motivoValido(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : '';
  if (m.length < 5) throw new ErroDeEntrada('diga o motivo em uma frase (mínimo 5 caracteres): ele fica no registro');
  return m.slice(0, 300);
}

/** Lê o SQL pelo parser; recusa vira `ErroDeEntrada` (mensagem em português com o que reescrever). Nada foi executado. */
export function analisar(sql: unknown, sistema: SistemaSql = 'rh'): AnaliseSql {
  try {
    return classificar(sql, sistema);
  } catch (e) {
    if (e instanceof ErroSql) throw new ErroDeEntrada(`${e.message} — NADA foi executado.`);
    throw e;
  }
}

/** O que a pessoa precisa ver: os comandos, o que cada um faz, o que será destruído. */
function resumoDe(a: AnaliseSql) {
  return a.comandos.map((c) => `${c.n}. [${c.acao === 'confirmar' ? 'DESTRÓI' : 'direto'}] ${c.tipo}: ${c.o_que}`);
}

const hashCurto = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16);

/** Rastro para o registro de auditoria do CONECTOR: sem o texto do SQL (pode ter CPF, salário…), com tipos, tabelas e um hash. O SQL inteiro fica no admin_log do sistema. */
interface Rastro {
  comandos?: string[];
  tabelas?: string[];
  hash?: string;
  tamanho?: number;
  snapshot?: string | null;
  resultado?: string;
}

function rastroDe(a: AnaliseSql, r: Rastro): void {
  r.comandos = a.comandos.map((c) => `${c.tipo}:${c.acao}`);
  r.tabelas = a.tabelasParaCopiar;
  r.hash = hashCurto(a.sql);
  r.tamanho = a.sql.length;
}

function incerto(e: unknown): boolean {
  return e instanceof ErroSistemas && (e.status === null || e.status >= 500);
}

/**
 * O caminho comum aos dois modos: classifica de novo, tira o backup (se a mudança pede), manda ao servidor e traduz a resposta.
 * Qualquer falha ANTES do `/sql` (inclusive o backup) deixa o banco intacto.
 */
export async function executarComBackup(
  c: ContaSistemas,
  quem: QuemSistemas,
  a: { sql: string; motivo: string; confirmado: boolean },
  rastro: Rastro,
  aoIncerto?: () => void,
): Promise<Saida> {
  const analise = analisar(a.sql, tipoDaConta(c));
  rastroDe(analise, rastro);
  let snapshot: Saida | null = null;
  if (analise.precisaSnapshot) {
    let b: Saida;
    try {
      const bruto = await c.fonte.chamar('POST', '/admin/v1/backup', { corpo: { sql: analise.sql, motivo: a.motivo, quem: quem.nome }, quem: quem.nome, timeoutMs: 90_000 });
      b = bruto && typeof bruto === 'object' ? (bruto as Saida) : {};
    } catch (e) {
      rastro.resultado = `backup falhou: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      throw new ErroDeEntrada(`O BACKUP ANTES DA MUDANÇA FALHOU (${e instanceof Error ? e.message : String(e)}): a mudança NÃO foi feita. Nada foi executado.`);
    }
    if (b.ok !== true || (b.necessario !== false && typeof b.snapshot_id !== 'string')) {
      const motivo = String(b.erro ?? 'o servidor não confirmou o backup').slice(0, 500);
      rastro.resultado = `backup recusado: ${motivo}`.slice(0, 300);
      throw new ErroDeEntrada(`O BACKUP ANTES DA MUDANÇA FALHOU (${motivo}): a mudança NÃO foi feita. Nada foi executado.`);
    }
    snapshot = b;
  }
  rastro.snapshot = snapshot && typeof snapshot.snapshot_id === 'string' ? snapshot.snapshot_id : null;
  let r: Saida;
  try {
    const bruto = await c.fonte.chamar('POST', '/admin/v1/sql', {
      corpo: { sql: analise.sql, motivo: a.motivo, quem: quem.nome, ...(rastro.snapshot ? { snapshot_id: rastro.snapshot } : {}), ...(a.confirmado ? { confirmado: true } : {}) },
      quem: quem.nome,
      timeoutMs: 90_000,
    });
    r = bruto && typeof bruto === 'object' ? (bruto as Saida) : {};
  } catch (e) {
    if (incerto(e)) {
      aoIncerto?.();
      rastro.resultado = 'sem resposta: resultado incerto';
      throw new ErroDeEntrada(
        `NÃO sei se o SQL foi executado (${(e as Error).message}). O backup foi feito (snapshot ${rastro.snapshot ?? 'não era preciso'}). Confira com sistemas_esquema, sistemas_consultar e sistemas_log antes de repetir (repetir um INSERT duplica linhas).`,
      );
    }
    rastro.resultado = `recusado: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    throw e;
  }
  if (r.ok === true) {
    rastro.resultado = 'ok';
    const nota = analise.mudaEstrutura ? 'Confira o resultado com sistemas_esquema.' : 'Confira o resultado com sistemas_consultar.';
    return {
      sistema: c.slug,
      ok: true,
      comandos: r.comandos ?? [],
      afetadas: r.afetadas ?? null,
      avisos: Array.isArray(r.avisos) ? r.avisos : analise.avisos,
      backup: snapshot ? { snapshot_id: snapshot.snapshot_id, linhas_por_tabela: snapshot.linhas_por_tabela ?? {}, guardado_por: '60 dias' } : 'não era preciso (só INSERT/CREATE de objeto novo sem tocar em linhas existentes)',
      registro: 'O pedido ficou no registro do sistema (admin_log, rota /sql) com quem pediu, quando, o SQL inteiro e as linhas afetadas, e no do conector (sem o texto do SQL).',
      instrucao: `${nota} Conte à pessoa o que mudou.${analise.renomeia ? ' Houve RENOMEAÇÃO: telas e funções que usam o nome antigo por texto deixam de funcionar.' : ''}`,
    };
  }
  if (r.ok === false) {
    const erro = String(r.erro ?? 'o servidor recusou sem dizer o motivo').slice(0, 800);
    rastro.resultado = `recusado: ${erro}`.slice(0, 300);
    const guarda = r.guarda === 'tabela_inteira' ? ' Foi desfeito. Para atingir a tabela inteira de propósito, escreva o comando SEM WHERE e use sistemas_preparar_sql (dois passos).' : ' O servidor roda o pedido todo numa transação e desfez o que já tinha feito; confira com sistemas_esquema.';
    throw new ErroDeEntrada(`o servidor NÃO aplicou: ${erro}.${guarda}`);
  }
  rastro.resultado = 'resposta inesperada: resultado incerto';
  aoIncerto?.();
  throw new ErroDeEntrada('NÃO sei se o SQL foi executado (o servidor respondeu algo fora do contrato). Confira com sistemas_esquema, sistemas_consultar e sistemas_log antes de repetir.');
}

// ------------------------------------------------------------------ direto

export async function sqlDireto(ctx: ContextoSistemas, quem: QuemSistemas, a: { sistema?: string; sql: string; motivo: string }, rastro: Rastro = {}): Promise<Saida> {
  const motivo = motivoValido(a.motivo);
  const c = resolverSistema(ctx, a.sistema);
  const analise = analisar(a.sql, tipoDaConta(c));
  rastroDe(analise, rastro);
  if (analise.decisao === 'confirmar') {
    const quais = analise.comandos.filter((c) => c.acao === 'confirmar');
    throw new ErroDeEntrada(
      `este SQL DESTRÓI ou mexe na tabela inteira (${quais.map((c) => `${c.n}. ${c.o_que}`).join('; ')}) e não roda direto: use sistemas_preparar_sql (mostra o que será destruído) e, com o ok da pessoa, sistemas_confirmar_sql. NADA foi executado.`,
    );
  }
  return executarComBackup(c, quem, { sql: analise.sql, motivo, confirmado: false }, rastro);
}

// ------------------------------------------------------------------ dois passos

export async function prepararSql(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { sistema?: string; sql: string; motivo: string },
  rastro: Rastro = {},
): Promise<Saida> {
  const motivo = motivoValido(a.motivo);
  const c = resolverSistema(ctx, a.sistema);
  const analise = analisar(a.sql, tipoDaConta(c));
  rastroDe(analise, rastro);
  // quantas linhas existem hoje nas tabelas tocadas (só leitura): a pessoa decide sabendo o tamanho do estrago
  const linhas: Record<string, number | null> = {};
  if (analise.tabelasParaCopiar.length) {
    try {
      const esq = (await c.fonte.chamar('GET', '/admin/v1/esquema')) as { tabelas?: Array<{ nome?: string; linhas?: number | null }> };
      for (const t of esq.tabelas ?? []) if (typeof t.nome === 'string' && analise.tabelasParaCopiar.includes(t.nome)) linhas[t.nome] = typeof t.linhas === 'number' ? t.linhas : null;
    } catch {
      // a contagem é um auxílio; sem ela a prévia segue
    }
  }
  const id = `sql-${randomBytes(9).toString('hex')}`;
  const expiraEm = pendentes.guardar(id, { usuario: quem.usuario, sistema: c.slug, operacao: 'sql', tabela: analise.tabelasParaCopiar.join(','), sqlLivre: { sql: analise.sql, motivo } });
  const destroi = analise.decisao === 'confirmar';
  return {
    sistema: c.slug,
    motivo,
    decisao: destroi ? 'exige confirmação (destrói ou mexe na tabela inteira)' : 'não destrói: poderia rodar direto por sistemas_sql',
    resumo: resumoDe(analise),
    avisos: analise.avisos,
    linhasHoje: linhas,
    backup: analise.precisaSnapshot ? `antes de executar o conector tira o snapshot do esquema${analise.tabelasParaCopiar.length ? ` e das linhas de ${analise.tabelasParaCopiar.join(', ')}` : ''}; se o backup falhar, nada é executado` : 'não é preciso',
    sql: analise.sql,
    confirmacao: id,
    expiraEm,
    instrucao: `Nada foi executado ainda. Mostre à pessoa o resumo${analise.avisos.length ? ', os avisos' : ''}${Object.keys(linhas).length ? ' e quantas linhas existem hoje' : ''} e, SÓ se ela aprovar, chame sistemas_confirmar_sql com confirmacao="${id}" (vale ${VALIDADE_MS / 60_000} minutos, uma vez).`,
  };
}

export async function confirmarSql(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { confirmacao: string },
  rastro: Rastro = {},
): Promise<Saida> {
  const id = String(a.confirmacao ?? '').trim();
  const p = pendentes.tirar(id, quem.usuario, 'sql');
  const { sql, motivo } = p.sqlLivre!;
  const c = resolverSistema(ctx, p.sistema);
  // resultado incerto (rede): o código volta, para a pessoa tentar de novo DEPOIS de conferir
  return executarComBackup(c, quem, { sql, motivo, confirmado: true }, rastro, () => pendentes.devolver(id, p));
}

// ------------------------------------------------------------------ ferramentas

/**
 * Mensagens de erro do parser e do banco citam pedaços do SQL e valores (`near "..."`, `invalid input syntax for type date: "12/13/1990"`): para o registro
 * do conector ficam sem o que está entre aspas e sem sequências longas de dígitos. O texto inteiro volta só para quem fez o pedido (e o SQL inteiro fica no admin_log do sistema).
 */
export function limparParaAuditoria(texto: string | undefined): string | undefined {
  return texto?.replace(/"[^"]{0,300}"/g, '"…"').replace(/'[^']{0,300}'/g, "'…'").replace(/\d{5,}/g, '#').slice(0, 240);
}

/** Auditoria do conector: tipos, tabelas, hash e resultado; nunca o texto do SQL nem os valores. */
function auditarSql(auditar: Auditar, rastro: () => Rastro): Auditar {
  return (r) => {
    const a = (r.argumentos ?? {}) as Record<string, unknown>;
    const x = rastro();
    auditar({
      ...r,
      erro: limparParaAuditoria(r.erro),
      argumentos: { sistema: a.sistema, motivo: a.motivo, confirmacao: a.confirmacao, comandos: x.comandos, tabelas: x.tabelas, sqlHash: x.hash, sqlTamanho: x.tamanho, snapshot: x.snapshot, resultado: limparParaAuditoria(x.resultado) ?? (r.ok ? 'ok' : undefined) },
    });
  };
}

export function registrarSqlSistemas(server: McpServer, ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, auditarBruto: Auditar): void {
  server.registerTool(
    'sistemas_sql',
    {
      title: 'Sistema novo (RH/Caixa ou Descontratos/Ficha): rodar SQL direto',
      description:
        'EXECUTA SQL no banco do sistema novo (RH/Caixa/Financeiro ou Descontratos/Ficha, conforme o parâmetro sistema — o Supabase antigo NÃO é mais usado), DIRETO, sem pedir confirmação: criar tabela (inclusive CREATE TABLE AS), view, view materializada, índice, função, gatilho, política (RLS), tipo, sequência; ' +
        'ALTER TABLE (coluna, restrição, valor padrão, tipo, ligar RLS); COMMENT; GRANT para authenticated/service_role; renomear; INSERT, UPDATE e DELETE COM WHERE. Pode mandar vários comandos juntos: rodam numa transação só (se um falha, nenhum fica). ' +
        'ANTES de mudar estrutura ou linhas existentes o sistema tira sozinho um backup (snapshot do esquema e das linhas tocadas, guardado 60 dias); se o backup falhar, nada roda. Tudo fica no registro (quem, quando, SQL, linhas afetadas). ' +
        'NÃO roda aqui, e pede o fluxo de DOIS passos (sistemas_preparar_sql → sistemas_confirmar_sql): DROP de qualquer coisa, TRUNCATE, UPDATE/DELETE sem WHERE (ou com WHERE que pega a tabela inteira), apagar coluna ou restrição, REVOKE, desligar RLS. ' +
        'NUNCA roda, nem com confirmação: auth/storage/catálogo do banco, senhas, as tabelas de usuários (rh_usuarios, dsc_usuarios), rh_log e admin_*, SET ROLE, SECURITY DEFINER, COPY, extensões, VACUUM, BEGIN/COMMIT, SQL dinâmico. ' +
        'Regras de escrita: tabelas no esquema public, nomes em minúsculas; view precisa de WITH (security_invoker = true); política precisa de TO authenticated; tabela nova sai com a segurança por linha (RLS) ligada e sem política (só a chave de serviço enxerga) — crie as políticas; função só em LANGUAGE sql ou plpgsql (plpgsql sem comandos de dados), sem SECURITY DEFINER. ' +
        'Antes de escrever, veja o sistemas_esquema. Para só LER dados use sistemas_consultar.',
      inputSchema: { sistema: SISTEMA, sql: SQL, motivo: MOTIVO },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => {
      const rastro: Rastro = {};
      return executar('sistemas_sql', args, auditarSql(auditarBruto, () => rastro), () => sqlDireto(ctx, quem, args, rastro));
    },
  );
  server.registerTool(
    'sistemas_preparar_sql',
    {
      title: 'Sistema novo (RH/Caixa ou Descontratos/Ficha): preparar SQL que destrói',
      description:
        'PASSO 1 de 2 para o SQL que DESTRÓI ou mexe na tabela inteira: DROP (tabela, view, índice, política, gatilho, função, sequência, tipo), TRUNCATE, UPDATE/DELETE sem WHERE, ALTER TABLE … DROP COLUMN/CONSTRAINT, REVOKE, desligar RLS. ' +
        'NÃO executa nada: lê o SQL, diz o que cada comando faz, o que será destruído, quantas linhas existem hoje nas tabelas tocadas e devolve um código. Mostre isso à pessoa e só chame sistemas_confirmar_sql se ela aprovar. ' +
        'O que nunca roda (auth, senhas, SET ROLE, SECURITY DEFINER, COPY, extensões…) é recusado já aqui.',
      inputSchema: { sistema: SISTEMA, sql: SQL, motivo: MOTIVO },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => {
      const rastro: Rastro = {};
      return executar('sistemas_preparar_sql', args, auditarSql(auditarBruto, () => rastro), () => prepararSql(ctx, pendentes, quem, args, rastro));
    },
  );
  server.registerTool(
    'sistemas_confirmar_sql',
    {
      title: 'Sistema novo (RH/Caixa ou Descontratos/Ficha): confirmar SQL que destrói',
      description:
        'PASSO 2 de 2: executa o SQL preparado, com o código de sistemas_preparar_sql. Só chame depois que a pessoa aprovou o resumo. O código vale 10 minutos e uma vez, só para quem preparou. ' +
        'Antes de executar o sistema tira o backup (esquema + linhas das tabelas tocadas); se falhar, nada roda. Depois confira com sistemas_esquema ou sistemas_consultar.',
      inputSchema: { confirmacao: z.string().min(4).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => {
      const rastro: Rastro = {};
      return executar('sistemas_confirmar_sql', args, auditarSql(auditarBruto, () => rastro), () => confirmarSql(ctx, pendentes, quem, args, rastro));
    },
  );
}
