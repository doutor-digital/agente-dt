/**
 * Alterar a ESTRUTURA do banco do sistema novo (tabelas, colunas, índices, views, políticas) pelo claude.ai, em dois passos:
 * `sistemas_preparar_estrutura(sql, motivo)` confere o SQL, devolve o que ele cria/altera e um código; `sistemas_confirmar_estrutura`
 * com o código manda o SQL ao servidor (`POST /admin/v1/estrutura`, que confere de novo e roda a função `admin_sql` do banco). DROP não existe.
 *
 * A conferência é do arquivo `estrutura-regras.ts` (PARSER REAL do Postgres, regras por árvore, lista permitida; o mesmo arquivo roda
 * no servidor antes do admin_sql, e o admin_sql do banco é a 3ª barreira). Aqui ficam só os dois passos e as ferramentas. Só quem está em
 * MCP_ESCRITA_EMAILS vê as ferramentas (o portão fica em producao.ts, junto com as outras escritas).
 *
 * Contrato que o servidor precisa ter (docs/ADMIN-API.md do sistemas-dd):
 *   POST /admin/v1/estrutura   corpo { sql, quem, motivo? }   resposta 200 { ok:true } | { ok:false, erro }
 *   (confere as regras, chama admin_sql(sql) e grava `quem` em admin_log; 4xx/5xx = { erro })
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { ErroEstrutura, MAX_SQL, analisarEstrutura as analisarPeloParser, type AnaliseEstrutura } from './estrutura-regras.js';
import { executar } from './ferramenta.js';
import { resolverSistema, VALIDADE_MS, type ContextoSistemas, type PendentesSistemas, type QuemSistemas, type Saida } from './sistemas.js';

export type { AnaliseEstrutura, ComandoEstrutura } from './estrutura-regras.js';

/** Confere o SQL e devolve o que ele faz; recusa vira `ErroDeEntrada` (mensagem em português com o que reescrever). */
export function analisarEstrutura(sql: unknown): AnaliseEstrutura {
  try {
    return analisarPeloParser(sql);
  } catch (e) {
    if (e instanceof ErroEstrutura) throw new ErroDeEntrada(e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ os dois passos

const MOTIVO = z.string().min(5).max(300).describe('por que — fica no registro (ex.: "tabela de preços do caixa")');

function motivoValido(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : '';
  if (m.length < 5) throw new ErroDeEntrada('diga o motivo em uma frase (mínimo 5 caracteres): ele fica no registro');
  return m.slice(0, 300);
}

export async function prepararEstrutura(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { sistema?: string; sql: string; motivo: string },
): Promise<Saida> {
  const motivo = motivoValido(a.motivo);
  const analise = analisarEstrutura(a.sql);
  const c = resolverSistema(ctx, a.sistema);
  const id = `est-${randomBytes(9).toString('hex')}`;
  const expiraEm = pendentes.guardar(id, { usuario: quem.usuario, sistema: c.slug, operacao: 'estrutura', tabela: '', estrutura: { sql: analise.sql, motivo, comandos: analise.comandos.length } });
  return {
    sistema: c.slug,
    motivo,
    resumo: analise.comandos.map((x) => `${x.n}. ${x.o_que}`),
    comandos: analise.comandos,
    avisos: analise.avisos,
    sql: analise.sql,
    confirmacao: id,
    expiraEm,
    instrucao: `Nada foi alterado ainda. Mostre à pessoa o resumo${analise.avisos.length ? ', os avisos' : ''} e o SQL e, se ela aprovar, chame sistemas_confirmar_estrutura com confirmacao="${id}" (vale ${VALIDADE_MS / 60_000} minutos, uma vez). Nada é apagado por aqui.`,
  };
}

/** `rastro` recebe o SQL e o resultado para o registro de auditoria do conector (a confirmação só leva o código). */
export async function confirmarEstrutura(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { confirmacao: string },
  rastro: { sql?: string; motivo?: string; resultado?: string } = {},
): Promise<Saida> {
  const id = String(a.confirmacao ?? '').trim();
  const p = pendentes.tirar(id, quem.usuario, 'estrutura');
  const { sql, motivo, comandos } = p.estrutura!;
  rastro.sql = sql;
  rastro.motivo = motivo;
  const c = resolverSistema(ctx, p.sistema);
  let r: Saida;
  try {
    const bruto = await c.fonte.chamar('POST', '/admin/v1/estrutura', { corpo: { sql, quem: quem.nome, motivo }, quem: quem.nome, timeoutMs: 120_000 });
    r = bruto && typeof bruto === 'object' ? (bruto as Saida) : {};
  } catch (e) {
    if (e instanceof ErroSistemas && (e.status === null || e.status >= 500)) {
      pendentes.devolver(id, p);
      rastro.resultado = 'sem resposta: resultado incerto';
      throw new ErroDeEntrada(`NÃO sei se a estrutura foi alterada (${e.message}). Confira com sistemas_esquema antes de repetir; o código ${id} continua valendo, mas só repita depois de conferir que NÃO foi aplicado (repetir um CREATE ou ADD que já existe dá erro "já existe"; CREATE OR REPLACE VIEW e ALTER POLICY sobrescrevem).`);
    }
    rastro.resultado = `recusado: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    throw e;
  }
  if (r.ok === true) {
    rastro.resultado = 'ok';
    return {
      sistema: c.slug,
      ok: true,
      comandos,
      motivo,
      registro: 'O comando ficou no registro do banco (admin_sql_log) e no do conector, com quem pediu.',
      instrucao: 'Confira o resultado com sistemas_esquema (tabela: o nome) e conte à pessoa o que mudou.',
    };
  }
  if (r.ok === false) {
    const erro = String(r.erro ?? 'o servidor recusou sem dizer o motivo').slice(0, 600);
    rastro.resultado = `recusado: ${erro}`.slice(0, 500);
    throw new ErroDeEntrada(`o servidor NÃO aplicou: ${erro}. O servidor roda o pedido todo num bloco só e desfaz o que ele já tinha feito quando um comando falha; mesmo assim confira com sistemas_esquema, corrija o SQL e prepare de novo (o código gastou).`);
  }
  // resposta sem "ok": não dá para saber
  pendentes.devolver(id, p);
  rastro.resultado = 'resposta inesperada: resultado incerto';
  throw new ErroDeEntrada(`NÃO sei se a estrutura foi alterada (o servidor respondeu algo fora do contrato). Confira com sistemas_esquema antes de repetir; o código ${id} continua valendo.`);
}

// ------------------------------------------------------------------ ferramentas

const SISTEMA = z.string().optional().describe('qual sistema (slug da unidade onde está cadastrado); pode omitir se só há um ligado');

/** O SQL fica no registro (é estrutura, não dado de paciente); o código de confirmação e o resultado também. */
function auditarEstrutura(auditar: Auditar): Auditar {
  return (r) => {
    const a = (r.argumentos ?? {}) as Record<string, unknown>;
    auditar({ ...r, argumentos: { ...a, sql: typeof a.sql === 'string' ? a.sql.slice(0, MAX_SQL) : a.sql } });
  };
}

export function registrarEstruturaSistemas(server: McpServer, ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, auditarBruto: Auditar): void {
  const auditar = auditarEstrutura(auditarBruto);
  server.registerTool(
    'sistemas_preparar_estrutura',
    {
      title: 'Sistema novo (RH/Caixa): preparar mudança de estrutura',
      description:
        'PASSO 1 de 2 para CRIAR ou ALTERAR a ESTRUTURA do banco do sistema novo: tabela, coluna, índice, view, política de acesso (RLS), comentário. ' +
        'NÃO executa nada: confere o SQL e devolve o resumo do que cria/altera, os avisos e um código. DROP, TRUNCATE, renomear e mexer em login/arquivos NÃO existem. ' +
        'Nomes em minúsculas, sem aspas, no esquema public; sem comentários (--) nem $$ (use COMMENT ON); DEFAULT/CHECK só com valores e funções nativas simples; uma tabela nova precisa de ENABLE ROW LEVEL SECURITY e política. Mostre o resumo e o SQL à ' +
        'pessoa e só chame sistemas_confirmar_estrutura se ela aprovar. Para alterar LINHAS (dados) use sistemas_preparar_alteracao.',
      inputSchema: { sistema: SISTEMA, sql: z.string().min(1).max(MAX_SQL).describe('um ou mais comandos separados por ";"'), motivo: MOTIVO },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_preparar_estrutura', args, auditar, () => prepararEstrutura(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_confirmar_estrutura',
    {
      title: 'Sistema novo (RH/Caixa): confirmar mudança de estrutura',
      description:
        'PASSO 2 de 2: executa no banco a mudança de estrutura preparada, com o código de sistemas_preparar_estrutura. Só chame depois que a pessoa aprovou o ' +
        'resumo. O código vale 10 minutos e uma vez, só para quem preparou, e executa exatamente o SQL que foi mostrado. Tudo fica no registro do banco. Depois confira com sistemas_esquema.',
      inputSchema: { confirmacao: z.string().min(4).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => {
      const rastro: { sql?: string; motivo?: string; resultado?: string } = {};
      const comRastro: Auditar = (r) => auditar({ ...r, argumentos: { ...(r.argumentos as object), sql: rastro.sql, motivo: rastro.motivo, resultado: rastro.resultado ?? (r.ok ? 'ok' : undefined) } });
      return executar('sistemas_confirmar_estrutura', args, comRastro, () => confirmarEstrutura(ctx, pendentes, quem, args, rastro));
    },
  );
}
