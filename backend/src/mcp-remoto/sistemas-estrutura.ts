/**
 * Criar/alterar a ESTRUTURA do banco do sistema novo pelo claude.ai, POR CAMPOS e em dois passos — sem SQL livre:
 *   `sistemas_preparar_tabela` / `sistemas_preparar_coluna` / `sistemas_preparar_indice` / `sistemas_preparar_regra` validam os campos (estrutura-campos.ts), GERAM o SQL,
 *   mostram o resumo e o SQL e devolvem um código; `sistemas_confirmar_estrutura` com o código manda ao servidor
 *   (`POST /admin/v1/estrutura`) os MESMOS campos + o SQL aprovado; o servidor valida de novo, gera o SQL e só executa se for idêntico.
 * REGRA DE ACESSO: quem lê/cria/altera as linhas de uma tabela nova se escolhe numa lista FECHADA de 4 modelos (`regra`), nunca por expressão digitada; a única coisa que a pessoa
 * informa além do modelo é o nome da coluna da unidade. `sistemas_preparar_regra` troca o modelo de uma tabela que ESTE caminho criou (dono rh_ddl); tabela de outro dono
 * (fin_lanc, rh_docs, caixa_lanc, portal_vinculo…) é recusada aqui e de novo no servidor.
 * DROP, renomear, apagar e SQL próprio não existem aqui. (O SQL livre volta depois, com parser; está guardado na branch wip/estrutura-parser.)
 *
 * Só quem está em MCP_ESCRITA_EMAILS vê as ferramentas (o portão fica em producao.ts, junto com as outras escritas).
 *
 * Contrato do servidor (docs/ADMIN-API.md do sistemas-dd):
 *   POST /admin/v1/estrutura   corpo { tipo:'tabela'|'coluna'|'indice'|'regra', ...campos, sqlAprovado, quem, motivo }
 *   resposta 200 { ok:true, sql:[...] } | 200 { ok:false, erro }   (erro de validação ou do banco é DADO; 4xx = pedido ruim; 5xx = não sei)
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import type { TabelaExistente } from './estrutura-campos.js';
import { ErroEstrutura, planejarColuna, planejarIndice, planejarRegra, planejarTabela, REGRAS, REGRAS_ACEITAS, type Existentes, type Plano } from './estrutura-campos.js';
import { executar } from './ferramenta.js';
import { resolverSistema, VALIDADE_MS, type ContaSistemas, type ContextoSistemas, type PendentesSistemas, type QuemSistemas, type Saida } from './sistemas.js';

const MOTIVO = z.string().min(5).max(300).describe('por que — fica no registro (ex.: "tabela de preços do caixa")');
const SISTEMA = z.string().optional().describe('qual sistema (slug da unidade onde está cadastrado); pode omitir se só há um ligado');

function motivoValido(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : '';
  if (m.length < 5) throw new ErroDeEntrada('diga o motivo em uma frase (mínimo 5 caracteres): ele fica no registro');
  return m.slice(0, 300);
}

/**
 * O que já existe no banco, lido do esquema do servidor (só leitura): nomes, colunas, tipos, dono e políticas. `dono` só vem de servidor a partir da 0.1.10.8-pol; sem ele a prévia
 * da troca de regra não consegue recusar tabela de outro dono, e QUEM RECUSA é o servidor (que lê o dono no banco, com a tabela travada).
 */
interface TabelaDoEsquema {
  nome?: string;
  view?: boolean;
  dono?: string;
  linhas?: number | null;
  colunas?: Array<{ nome?: string; tipo?: string }>;
  politicas?: Array<{ nome?: string }>;
}
async function lerExistentes(c: ContaSistemas): Promise<Existentes> {
  const r = (await c.fonte.chamar('GET', '/admin/v1/esquema')) as { tabelas?: TabelaDoEsquema[] };
  const tabelas = new Map<string, TabelaExistente>();
  for (const t of r.tabelas ?? []) {
    if (typeof t.nome !== 'string') continue;
    // um laço só: coluna sem `tipo` entra em `colunas` mas NÃO em `tipos` (tipo desconhecido, não a palavra "undefined")
    const colunas: string[] = [];
    const tipos = new Map<string, string>();
    for (const x of t.colunas ?? []) {
      colunas.push(String(x.nome));
      if (typeof x.tipo === 'string') tipos.set(String(x.nome), x.tipo);
    }
    tabelas.set(t.nome, {
      linhas: typeof t.linhas === 'number' ? t.linhas : null,
      colunas,
      tipos,
      ...(typeof t.dono === 'string' ? { dono: t.dono } : {}),
      relkind: t.view ? 'v' : 'r',
      politicas: (t.politicas ?? []).map((x) => String(x.nome)),
    });
  }
  return { tabelas };
}

/** Roda as regras e vira `ErroDeEntrada` (mensagem em português com o que corrigir). */
function validar(fn: () => Plano): Plano {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ErroEstrutura) throw new ErroDeEntrada(e.message);
    throw e;
  }
}

async function preparar(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  sistema: string | undefined,
  motivoBruto: unknown,
  entrada: Record<string, unknown>,
  planejar: (ex: Existentes) => Plano,
): Promise<Saida> {
  const motivo = motivoValido(motivoBruto);
  const c = resolverSistema(ctx, sistema);
  const existentes = await lerExistentes(c);
  const p = validar(() => planejar(existentes));
  const id = `est-${randomBytes(9).toString('hex')}`;
  const sql = p.sql.join(';\n');
  const expiraEm = pendentes.guardar(id, { usuario: quem.usuario, sistema: c.slug, operacao: 'estrutura', tabela: p.tabela, estrutura: { sql, motivo, comandos: p.sql.length, entrada } });
  return {
    sistema: c.slug,
    motivo,
    resumo: p.resumo,
    avisos: p.avisos,
    sql,
    confirmacao: id,
    expiraEm,
    instrucao: `Nada foi alterado ainda. Mostre à pessoa o resumo${p.avisos.length ? ', os avisos' : ''} e o SQL e, se ela aprovar, chame sistemas_confirmar_estrutura com confirmacao="${id}" (vale ${VALIDADE_MS / 60_000} minutos, uma vez). Nada é apagado por aqui.`,
  };
}

export function prepararTabela(ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, a: { sistema?: string; nome: string; colunas: unknown[]; regra?: string; coluna_unidade?: string; motivo: string }): Promise<Saida> {
  // só vão ao servidor os campos que a pessoa informou: sem `regra` o pedido é o de sempre (servidor antigo entende)
  const campos = { nome: a.nome, colunas: a.colunas, ...(a.regra !== undefined ? { regra: a.regra } : {}), ...(a.coluna_unidade !== undefined ? { coluna_unidade: a.coluna_unidade } : {}) };
  return preparar(ctx, pendentes, quem, a.sistema, a.motivo, { tipo: 'tabela', ...campos }, (ex) => planejarTabela(campos, ex));
}

export function prepararRegra(ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, a: { sistema?: string; tabela: string; regra: string; coluna_unidade?: string; motivo: string }): Promise<Saida> {
  const campos = { tabela: a.tabela, regra: a.regra, ...(a.coluna_unidade !== undefined ? { coluna_unidade: a.coluna_unidade } : {}) };
  return preparar(ctx, pendentes, quem, a.sistema, a.motivo, { tipo: 'regra', ...campos }, (ex) => planejarRegra(campos, ex));
}

export function prepararColuna(ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, a: { sistema?: string; tabela: string; coluna: unknown; motivo: string }): Promise<Saida> {
  return preparar(ctx, pendentes, quem, a.sistema, a.motivo, { tipo: 'coluna', tabela: a.tabela, coluna: a.coluna }, (ex) => planejarColuna({ tabela: a.tabela, coluna: a.coluna }, ex));
}

export function prepararIndice(ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, a: { sistema?: string; tabela: string; colunas: unknown[]; unico?: boolean; motivo: string }): Promise<Saida> {
  return preparar(ctx, pendentes, quem, a.sistema, a.motivo, { tipo: 'indice', tabela: a.tabela, colunas: a.colunas, ...(a.unico !== undefined ? { unico: a.unico } : {}) }, (ex) => planejarIndice({ tabela: a.tabela, colunas: a.colunas, unico: a.unico }, ex));
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
  const { sql, motivo, comandos, entrada } = p.estrutura!;
  rastro.sql = sql;
  rastro.motivo = motivo;
  const c = resolverSistema(ctx, p.sistema);
  let r: Saida;
  try {
    const bruto = await c.fonte.chamar('POST', '/admin/v1/estrutura', { corpo: { ...entrada, sqlAprovado: sql, quem: quem.nome, motivo }, quem: quem.nome, timeoutMs: 120_000 });
    r = bruto && typeof bruto === 'object' ? (bruto as Saida) : {};
  } catch (e) {
    if (e instanceof ErroSistemas && (e.status === null || e.status >= 500)) {
      pendentes.devolver(id, p);
      rastro.resultado = 'sem resposta: resultado incerto';
      throw new ErroDeEntrada(`NÃO sei se a estrutura foi alterada (${e.message}). Confira com sistemas_esquema antes de repetir; o código ${id} continua valendo, mas só repita depois de conferir que NÃO foi aplicado (repetir um CREATE ou ADD que já existe dá erro "já existe").`);
    }
    // servidor ainda na API 0.1.9 (ou anterior): a rota /estrutura dele espera `sql` e este conector manda os campos. Foi o defeito de 03/11 ("escreva o SQL (campo sql)").
    if (e instanceof ErroSistemas && /escreva o SQL \(campo sql\)/.test(e.message)) {
      rastro.resultado = 'servidor desatualizado';
      throw new ErroDeEntrada('o servidor do sistema novo está numa versão ANTIGA (antes da 0.1.10) e não entende a estrutura por campos. NADA foi criado. Avise o João para publicar a API 0.1.10.1 (ou mais nova); enquanto isso, nada de tabela nova por aqui.');
    }
    // servidor antes da 0.1.10.8-pol: não conhece o tipo "regra" (400) — e, numa tabela com `regra`, gera o SQL de antes e por isso "difere" do aprovado
    if (e instanceof ErroSistemas && e.status === 400 && /tipo do pedido: use tabela, coluna ou indice\b/.test(e.message) && String(entrada.tipo) === 'regra') {
      rastro.resultado = 'servidor desatualizado';
      throw new ErroDeEntrada('o servidor do sistema novo está numa versão ANTERIOR à 0.1.10.8-pol e não conhece a troca de regra de acesso. NADA foi alterado. Avise o João para publicar a versão nova.');
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
      registro: 'O pedido ficou no registro do sistema (admin_log) e no do conector, com quem pediu.',
      instrucao: 'Confira o resultado com sistemas_esquema (tabela: o nome) e conte à pessoa o que mudou.',
    };
  }
  if (r.ok === false) {
    const erro = String(r.erro ?? 'o servidor recusou sem dizer o motivo').slice(0, 600);
    rastro.resultado = `recusado: ${erro}`.slice(0, 500);
    // o servidor 0.1.10.6 recusa o tipo "regra" com 400; o texto também é aceito vindo como 200 ok:false (contrato do arquivo: erro de validação é dado)
    if (String(entrada.tipo) === 'regra' && /tipo do pedido: use tabela, coluna ou indice\b/.test(erro)) {
      throw new ErroDeEntrada('o servidor do sistema novo está numa versão ANTERIOR à 0.1.10.8-pol e não conhece a troca de regra de acesso. NADA foi alterado. Avise o João para publicar a versão nova.');
    }
    const antigo = (entrada.regra !== undefined || String(entrada.tipo) === 'regra') && /o SQL que o servidor gera agora é diferente/.test(erro)
      ? ' Se a tabela não mudou desde a prévia e você escolheu uma regra de acesso, o servidor pode estar numa versão ANTERIOR à 0.1.10.8-pol (que ainda não conhece as regras): avise o João para publicar. Se a tabela mudou, é só preparar de novo.'
      : '';
    throw new ErroDeEntrada(`o servidor NÃO aplicou: ${erro}. O servidor roda o pedido todo numa transação e desfaz o que já tinha feito quando algo falha; mesmo assim confira com sistemas_esquema e prepare de novo (o código gastou).${antigo}`);
  }
  pendentes.devolver(id, p);
  rastro.resultado = 'resposta inesperada: resultado incerto';
  throw new ErroDeEntrada(`NÃO sei se a estrutura foi alterada (o servidor respondeu algo fora do contrato). Confira com sistemas_esquema antes de repetir; o código ${id} continua valendo.`);
}

// ------------------------------------------------------------------ ferramentas

/** O SQL gerado e os campos ficam no registro (é estrutura, não dado de paciente). */
function auditarEstrutura(auditar: Auditar): Auditar {
  return (r) => auditar(r);
}

/** A lista de regras, com o que cada uma faz, para a descrição das ferramentas (a lista vem do mesmo arquivo que o servidor usa: não há como divergir). */
const TEXTO_DAS_REGRAS = REGRAS_ACEITAS.map((r) => `${r}: ${REGRAS[r]!.descricao}`).join(' | ');
const REGRA = z.enum(REGRAS_ACEITAS as [string, ...string[]]);
const COLUNA_UNIDADE = z.string().max(60).optional().describe('só nas regras que filtram pela unidade: o NOME da coluna text onde fica o slug da unidade (padrão: "unidade"). A coluna tem de existir');

const COLUNA = z.object({
  nome: z.string().max(60).describe('minúsculas, números e _ (2 a 41 caracteres), começando por letra'),
  tipo: z.string().max(30).describe('text, integer, bigint, numeric(12,2), boolean, date, timestamptz, uuid ou jsonb'),
  obrigatoria: z.boolean().optional(),
  padrao: z.union([z.string().max(80), z.number(), z.boolean()]).nullable().optional().describe('valor padrão: número, true/false, texto curto, "now()", "current_date", "gen_random_uuid()", "{}" ou "[]" (conforme o tipo)'),
  unica: z.boolean().optional(),
});

export function registrarEstruturaSistemas(server: McpServer, ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, auditarBruto: Auditar): void {
  const auditar = auditarEstrutura(auditarBruto);
  const nota =
    'NÃO executa nada: valida os campos, GERA o SQL e devolve o resumo, os avisos, o SQL e um código. Mostre isso à pessoa e só chame sistemas_confirmar_estrutura se ela aprovar. ' +
    'É só para CRIAR/ALTERAR estrutura (não há DROP, renomear nem SQL próprio). Para alterar LINHAS (dados) use sistemas_preparar_alteracao.';
  server.registerTool(
    'sistemas_preparar_tabela',
    {
      title: 'Sistema novo (RH/Caixa): preparar tabela nova',
      description:
        'PASSO 1 de 2 para CRIAR uma TABELA nova no sistema novo, por campos (sem SQL). A tabela sempre ganha id (uuid, chave) e criado_em (agora), liga a segurança por linha (RLS), cria as políticas da REGRA DE ACESSO ' +
        'escolhida e dá os privilégios certos ao banco (tela, servidor e a leitura da Lia), conferindo tudo depois de gravar. Quem vê/cria/altera as linhas se escolhe pela `regra` (lista fechada, sem digitar expressão): ' + TEXTO_DAS_REGRAS + '. ' +
        'Sem `regra`: com coluna "unidade" (text) vale unidade_le_gestao_grava; sem ela, gestao_e_financeiro. Nenhuma regra deixa a tela apagar. A leitura da Lia (consulta) vê TODAS as linhas de qualquer regra. ' +
        'Tipos: text, integer, bigint, numeric(12,2), boolean, date, timestamptz, uuid, jsonb. Não vale para nomes de tabelas fechadas (rh_usuarios, rh_docs, rh_log, rh_site*, admin_*, auth*, storage*…). ' + nota,
      inputSchema: { sistema: SISTEMA, nome: z.string().max(60).describe('nome da tabela: minúsculas, números e _'), colunas: z.array(COLUNA).min(1).max(30), regra: REGRA.optional(), coluna_unidade: COLUNA_UNIDADE, motivo: MOTIVO },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_preparar_tabela', args, auditar, () => prepararTabela(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_preparar_regra',
    {
      title: 'Sistema novo (RH/Caixa): preparar troca da regra de acesso de uma tabela',
      description:
        'PASSO 1 de 2 para TROCAR a regra de acesso (quem vê/cria/altera as linhas) de uma tabela que ESTE caminho criou (sistemas_preparar_tabela). A regra se escolhe numa lista fechada, sem digitar expressão: ' + TEXTO_DAS_REGRAS + '. ' +
        'Só vale para tabela criada por aqui (dono rh_ddl): tabela antiga (fin_*, caixa_lanc, rh_docs, portal_vinculo, colaboradores…), tabela fechada e tabela com política de outra origem são RECUSADAS (essas só o João muda, no servidor). ' +
        'As políticas de antes ficam guardadas (admin_backup) e o servidor confere depois de gravar. A troca vale NA HORA para todas as linhas que a tabela já tem. ' + nota,
      inputSchema: { sistema: SISTEMA, tabela: z.string().max(60), regra: REGRA, coluna_unidade: COLUNA_UNIDADE, motivo: MOTIVO },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_preparar_regra', args, auditar, () => prepararRegra(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_preparar_coluna',
    {
      title: 'Sistema novo (RH/Caixa): preparar coluna nova',
      description:
        'PASSO 1 de 2 para ACRESCENTAR uma COLUNA a uma tabela que já existe (não fechada), por campos. Coluna obrigatória em tabela que já tem linhas precisa de "padrao". ' + nota,
      inputSchema: { sistema: SISTEMA, tabela: z.string().max(60), coluna: COLUNA, motivo: MOTIVO },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_preparar_coluna', args, auditar, () => prepararColuna(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_preparar_indice',
    {
      title: 'Sistema novo (RH/Caixa): preparar índice',
      description: 'PASSO 1 de 2 para CRIAR um ÍNDICE (de 1 a 4 colunas, opcionalmente único) numa tabela que já existe (não fechada). ' + nota,
      inputSchema: { sistema: SISTEMA, tabela: z.string().max(60), colunas: z.array(z.string().max(60)).min(1).max(4), unico: z.boolean().optional(), motivo: MOTIVO },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_preparar_indice', args, auditar, () => prepararIndice(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_confirmar_estrutura',
    {
      title: 'Sistema novo (RH/Caixa): confirmar mudança de estrutura',
      description:
        'PASSO 2 de 2: executa no banco a mudança de estrutura preparada (tabela, coluna, índice ou regra de acesso), com o código devolvido pela ferramenta de preparar. Só chame depois que a pessoa aprovou o ' +
        'resumo e o SQL. O código vale 10 minutos e uma vez, só para quem preparou, e o servidor só executa se gerar exatamente o SQL que foi mostrado. Tudo fica no registro do banco. Depois confira com sistemas_esquema.',
      inputSchema: { confirmacao: z.string().min(4).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => {
      const rastro: { sql?: string; motivo?: string; resultado?: string } = {};
      const comRastro: Auditar = (r) => auditar({ ...r, argumentos: { confirmacao: (r.argumentos as { confirmacao?: string }).confirmacao, sql: rastro.sql, motivo: rastro.motivo, resultado: rastro.resultado ?? (r.ok ? 'ok' : undefined) } });
      return executar('sistemas_confirmar_estrutura', args, comRastro, () => confirmarEstrutura(ctx, pendentes, quem, args, rastro));
    },
  );
}
