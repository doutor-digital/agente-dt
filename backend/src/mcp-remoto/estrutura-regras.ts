/**
 * REGRAS DE ESTRUTURA (um arquivo só): o que a Lia pode mandar para `sistemas_preparar_estrutura` / `POST /admin/v1/estrutura`.
 *
 * Este arquivo é IDÊNTICO nos dois repositórios (agente-dt: backend/src/mcp-remoto/estrutura-regras.ts; sistemas-dd: src/estrutura-regras.ts).
 * Um teste de cada lado confere o hash do arquivo e roda o MESMO conjunto de casos (estrutura-casos.json). Mudou aqui, mude lá igualzinho.
 * Só importa `libpg-query`; sem import local, sem enum, sem parameter property (roda no Node com type-stripping e no tsc).
 *
 * Por que parser e não regex: texto de SQL tem aspas, $tag$, comentário, e'\'' e quebras que cada regex lê de um jeito e o Postgres de outro
 * (isso já furou 3 rodadas de revisão). Aqui o SQL é lido pelo PARSER DO POSTGRES (libpg-query = o código do próprio Postgres em WASM)
 * e as regras olham a ÁRVORE, não o texto:
 *   - lista PERMITIDA de comandos; o que não está nela é recusado (default-deny);
 *   - em cada nó, só as chaves conhecidas; chave desconhecida = recusa (nada de opção escondida: INHERITS, USING, WITH, TABLESPACE…);
 *   - toda expressão (default, check, índice, predicado, gerada, política, view) passa por um verificador que só conhece nós inofensivos:
 *     funções só da lista curta (sem esquema), operadores só da lista, tipos só da lista, nunca subconsulta;
 *   - nome de tabela/coluna/esquema vem já resolvido pelo parser (aspas, maiúsculas, `"auth".x`, `u&"…"` viram o nome de verdade).
 */
import { loadModule, parseSync } from 'libpg-query';

await loadModule();

export const MAX_SQL = 20_000;
export const MAX_COMANDOS = 25;

export class ErroEstrutura extends Error {}

export interface ComandoEstrutura {
  n: number;
  tipo: string;
  o_que: string;
}
export interface AnaliseEstrutura {
  /** o SQL como veio (é o que vai ao servidor) */
  sql: string;
  comandos: ComandoEstrutura[];
  avisos: string[];
}

// ------------------------------------------------------------------ listas

/** Tabelas (e funções) que NÃO se tocam por aqui: usuários, documentos, registros, a página do RH e a administração. Nome exato, já resolvido pelo parser. */
const FECHADAS = new Set(['rh_usuarios', 'rh_docs', 'rh_log', 'rh_site', 'rh_site_stage', 'admin_log', 'admin_backup', 'admin_sql_log']);
/** Nome fechado, ou derivado dele (índice, sequência, restrição: `rh_docs_pkey`, `admin_log_id_seq`). */
const fechada = (nome: string): boolean => nome.startsWith('admin_sql') || [...FECHADAS].some((f) => nome === f || nome.startsWith(`${f}_`));

const PAPEIS = new Set(['authenticated', 'service_role']);
const PRIVILEGIOS = new Set(['select', 'insert', 'update', 'delete', 'usage']);
const METODOS_DE_INDICE = new Set(['btree', 'hash', 'gin', 'gist', 'brin']);

/** Funções nativas inofensivas (sem esquema). Nenhuma escreve, lê tabela ou olha o ambiente. */
const FUNCOES = new Set([
  'now', 'gen_random_uuid', 'lower', 'upper', 'length', 'char_length', 'character_length', 'btrim', 'ltrim', 'rtrim', 'abs', 'round', 'floor',
  'ceil', 'ceiling', 'substr', 'substring', 'concat', 'replace', 'left', 'right', 'date_trunc', 'date_part', 'extract', 'to_char', 'timezone',
]);
/** Agregados: só dentro de VIEW. */
const AGREGADOS = new Set(['count', 'sum', 'avg', 'min', 'max']);
/** Funções auxiliares de política (STABLE: o Postgres não deixa função STABLE gravar). Só em CREATE/ALTER POLICY. */
const FUNCOES_DE_POLITICA = new Set([
  'rh_admin', 'rh_papel', 'meu_perfil', 'meu_colaborador', 'meu_tenant', 'caixa_gestor', 'caixa_minha_unidade', 'caixa_pode', 'rh_fin_le',
  'rh_fin_escreve', 'rh_fin_ok', 'rh_socio_colab_ok', 'rh_socio_doc_ok', 'rh_socio_emp', 'rh_socio_fin', 'rh_socio_slug', 'rh_socio_un', 'rh_socio_vaga_ok',
]);
const OPERADORES = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '^', '||', '~~', '~~*', '!~~', '!~~*', '~', '~*', '!~', '!~*', '->', '->>', '@>', '<@', '&&']);
const TIPOS = new Set([
  'text', 'varchar', 'bpchar', 'char', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'date', 'time', 'timetz', 'timestamp',
  'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'bytea', 'serial', 'smallserial', 'bigserial',
]);
const SVF_OK = new Set(['SVFOP_CURRENT_DATE', 'SVFOP_CURRENT_TIME', 'SVFOP_CURRENT_TIME_N', 'SVFOP_CURRENT_TIMESTAMP', 'SVFOP_CURRENT_TIMESTAMP_N', 'SVFOP_LOCALTIME', 'SVFOP_LOCALTIME_N', 'SVFOP_LOCALTIMESTAMP', 'SVFOP_LOCALTIMESTAMP_N']);

const ACEITO =
  'Aceito: CREATE TABLE (só "nome ( colunas )"), CREATE INDEX, CREATE VIEW (com security_invoker), ALTER TABLE (ADD COLUMN, ADD CONSTRAINT, ALTER COLUMN SET DEFAULT/TYPE/NOT NULL, ENABLE ROW LEVEL SECURITY), ' +
  'CREATE/ALTER POLICY (TO authenticated), COMMENT ON e GRANT/REVOKE de SELECT/INSERT/UPDATE/DELETE para authenticated ou service_role. O resto (funções, gatilhos, renomear, apagar) é com quem administra o servidor.';

const POR_TIPO_DE_COMANDO: Record<string, string> = {
  DropStmt: 'DROP não existe por aqui: para remover algo, peça a quem administra o servidor',
  TruncateStmt: 'TRUNCATE não existe por aqui',
  CopyStmt: 'COPY não existe por aqui',
  SelectStmt: 'consultar dados não passa por aqui: para ler use sistemas_consultar',
  InsertStmt: 'escrever dados não passa por aqui: use sistemas_preparar_alteracao',
  UpdateStmt: 'escrever dados não passa por aqui: use sistemas_preparar_alteracao',
  DeleteStmt: 'apagar dados não passa por aqui: use sistemas_preparar_alteracao',
  MergeStmt: 'escrever dados não passa por aqui: use sistemas_preparar_alteracao',
  CreateTableAsStmt: 'CREATE TABLE AS / SELECT INTO não é permitido (executa a consulta e copia ou escreve dados): crie a tabela com "CREATE TABLE nome ( colunas )"',
  DoStmt: 'DO (SQL dinâmico) não é permitido',
  CallStmt: 'CALL não é permitido',
  CreateFunctionStmt: 'criar função não é permitido por aqui: é com quem administra o servidor',
  CreateTrigStmt: 'gatilho (trigger) não é permitido por aqui',
  RuleStmt: 'CREATE RULE não é permitido por aqui',
  VariableSetStmt: 'SET/RESET não é permitido por aqui (nem trocar de papel)',
  TransactionStmt: 'BEGIN/COMMIT/ROLLBACK não são permitidos: o servidor já roda o pedido todo como uma transação só',
  RenameStmt: 'renomear não é permitido por aqui (quebra quem lê o nome antigo): crie uma coluna ou tabela nova',
  AlterOwnerStmt: 'mudar o dono não é permitido por aqui',
  CreateRoleStmt: 'criar papel não é permitido por aqui',
  AlterRoleStmt: 'alterar papel/usuário não é permitido por aqui',
  GrantRoleStmt: 'GRANT de papel para papel não é permitido por aqui',
  AlterDefaultPrivilegesStmt: 'ALTER DEFAULT PRIVILEGES não é permitido por aqui',
  CreateSchemaStmt: 'criar esquema não é permitido por aqui',
  CreateExtensionStmt: 'criar extensão não é permitido por aqui',
  VacuumStmt: 'VACUUM/ANALYZE não é permitido por aqui',
  ExecuteStmt: 'EXECUTE não é permitido',
  PrepareStmt: 'PREPARE não é permitido',
  RefreshMatViewStmt: 'view materializada não é permitida por aqui',
  LockStmt: 'LOCK não é permitido por aqui',
};

// ------------------------------------------------------------------ utilitários da árvore

// o JSON do parser é heterogêneo (cada nó é { NomeDoTipo: {...} }); por isso `any` aqui, e as regras conferem cada campo
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type No = any;

function recusa(msg: string): never {
  throw new ErroEstrutura(msg);
}

/** `{ CreateStmt: {...} }` -> ['CreateStmt', {...}] */
function tipoDe(no: No): [string, No] {
  const k = no && typeof no === 'object' ? Object.keys(no) : [];
  if (k.length !== 1) recusa('estrutura de SQL inesperada');
  return [k[0]!, no[k[0]!]];
}

/** Só as chaves conhecidas (location e afins são ignoradas). Chave desconhecida = opção que não prevemos = recusa. */
function so(no: No, permitidas: string[], onde: string): void {
  for (const k of Object.keys(no)) {
    if (k === 'location' || k === 'stmt_location' || k === 'stmt_len' || permitidas.includes(k)) continue;
    recusa(`${onde}: a opção "${k}" não é permitida por aqui. ${ACEITO}`);
  }
}

const strings = (lista: No, onde: string): string[] => {
  if (lista === undefined) return [];
  if (!Array.isArray(lista)) recusa(`${onde}: lista inesperada`);
  return lista.map((x: No) => {
    const [t, v] = tipoDe(x);
    if (t !== 'String') recusa(`${onde}: nome inesperado`);
    return String(v.sval);
  });
};

/** RangeVar -> nome da tabela. Só o esquema public; nunca tabela fechada. */
function relacao(rvBruto: No, onde: string): string {
  // o parser entrega o RangeVar direto em alguns campos (relation, table, view) e embrulhado { RangeVar: … } em listas (FROM, GRANT)
  const v: No = rvBruto && rvBruto.RangeVar ? rvBruto.RangeVar : rvBruto;
  if (!v || typeof v !== 'object' || typeof v.relname !== 'string') recusa(`${onde}: esperava o nome de uma tabela`);
  so(v, ['schemaname', 'relname', 'inh', 'relpersistence', 'alias'], `${onde} (nome da tabela)`);
  if (v.schemaname !== undefined && v.schemaname !== 'public') recusa(`${onde}: só o esquema "public" é permitido (recebi "${v.schemaname}.${v.relname}")`);
  if (v.relpersistence === 't') recusa(`${onde}: tabela temporária não faz sentido por aqui`);
  semFechada(v.relname, onde);
  return String(v.relname);
}

function semFechada(nome: string, onde: string): void {
  if (fechada(nome)) {
    recusa(`${onde}: "${nome}" é tabela fechada: usuários, documentos, registros, página do RH e administração não se alteram por aqui (nem GRANT, política, view, comentário ou restrição sobre elas). Usuário e papel: sistemas_usuario; dados: sistemas_preparar_alteracao.`);
  }
}

/** Qualquer menção a nome fechado em QUALQUER lugar da árvore (colunas, listas de nomes, referências). Texto entre aspas simples não conta: é dado, não nome. */
function varrerFechadas(no: No, onde: string): void {
  if (Array.isArray(no)) {
    for (const x of no) varrerFechadas(x, onde);
    return;
  }
  if (!no || typeof no !== 'object') return;
  for (const [k, v] of Object.entries(no)) {
    if (k === 'String' && v && typeof v === 'object' && typeof (v as No).sval === 'string') semFechada((v as No).sval, onde);
    else if (k === 'relname' && typeof v === 'string') semFechada(v, onde);
    else varrerFechadas(v, onde);
  }
}

// ------------------------------------------------------------------ tipos e expressões

function tipoPermitido(tn: No, onde: string): string {
  so(tn, ['names', 'typmods', 'typemod', 'arrayBounds'], `${onde} (tipo)`);
  const nomes = strings(tn.names, onde);
  const ultimo = nomes.at(-1) ?? '';
  const ok = (nomes.length === 1 || (nomes.length === 2 && nomes[0] === 'pg_catalog')) && TIPOS.has(ultimo);
  if (!ok) recusa(`${onde}: o tipo "${nomes.join('.')}" não é permitido. Tipos aceitos: ${[...TIPOS].join(', ')}`);
  for (const m of tn.typmods ?? []) expressao(m, { colunas: false }, onde);
  return ultimo;
}

interface Ctx {
  colunas: boolean;
  politica?: boolean;
  agregados?: boolean;
}

/** Só nós inofensivos; função fora da lista, subconsulta e o que não conhecemos são recusados. */
function expressao(no: No, ctx: Ctx, onde: string): void {
  const [t, v] = tipoDe(no);
  switch (t) {
    case 'A_Const':
      if (v.bsval !== undefined) recusa(`${onde}: texto de bits não é permitido`);
      return;
    case 'ColumnRef':
      if (!ctx.colunas) recusa(`${onde}: aqui não cabe referência a coluna (só valor fixo)`);
      so(v, ['fields'], onde);
      for (const f of v.fields ?? []) {
        const [ft] = tipoDe(f);
        if (ft !== 'String' && ft !== 'A_Star') recusa(`${onde}: referência de coluna inesperada`);
      }
      return;
    case 'TypeCast':
      so(v, ['arg', 'typeName'], onde);
      expressao(v.arg, ctx, onde);
      tipoPermitido(v.typeName, onde);
      return;
    case 'A_Expr': {
      so(v, ['kind', 'name', 'lexpr', 'rexpr', 'rexpr_list_start', 'rexpr_list_end'], onde);
      const kinds = ['AEXPR_OP', 'AEXPR_IN', 'AEXPR_LIKE', 'AEXPR_ILIKE', 'AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN', 'AEXPR_NULLIF', 'AEXPR_DISTINCT', 'AEXPR_NOT_DISTINCT', 'AEXPR_SIMILAR'];
      if (!kinds.includes(v.kind)) recusa(`${onde}: operador (${v.kind}) não permitido`);
      const nome = strings(v.name, onde);
      if (v.kind === 'AEXPR_OP' || v.kind === 'AEXPR_LIKE' || v.kind === 'AEXPR_ILIKE') {
        if (nome.length !== 1 || !OPERADORES.has(nome[0]!)) recusa(`${onde}: o operador "${nome.join('.')}" não é permitido`);
      }
      if (v.lexpr) expressao(v.lexpr, ctx, onde);
      if (v.rexpr) expressao(v.rexpr, ctx, onde);
      return;
    }
    case 'List':
      for (const x of v.items ?? []) expressao(x, ctx, onde);
      return;
    case 'BoolExpr':
      so(v, ['boolop', 'args'], onde);
      for (const x of v.args ?? []) expressao(x, ctx, onde);
      return;
    case 'NullTest':
    case 'BooleanTest':
      so(v, ['arg', 'nulltesttype', 'booltesttype'], onde);
      expressao(v.arg, ctx, onde);
      return;
    case 'CoalesceExpr':
      so(v, ['args'], onde);
      for (const x of v.args ?? []) expressao(x, ctx, onde);
      return;
    case 'MinMaxExpr':
      so(v, ['op', 'args'], onde);
      for (const x of v.args ?? []) expressao(x, ctx, onde);
      return;
    case 'CaseExpr':
      so(v, ['arg', 'args', 'defresult'], onde);
      if (v.arg) expressao(v.arg, ctx, onde);
      if (v.defresult) expressao(v.defresult, ctx, onde);
      for (const w of v.args ?? []) {
        const [, cw] = tipoDe(w);
        so(cw, ['expr', 'result'], onde);
        expressao(cw.expr, ctx, onde);
        expressao(cw.result, ctx, onde);
      }
      return;
    case 'SQLValueFunction':
      if (!SVF_OK.has(v.op)) recusa(`${onde}: ${String(v.op).replace('SVFOP_', '')} não é permitido (só CURRENT_DATE, CURRENT_TIMESTAMP e parecidos)`);
      return;
    case 'FuncCall': {
      so(v, ['funcname', 'args', 'funcformat', 'agg_star'], onde);
      const nome = strings(v.funcname, onde);
      const base = nome.length === 2 && nome[0] === 'pg_catalog' ? nome[1]! : nome.length === 1 ? nome[0]! : '';
      const ok = FUNCOES.has(base) || (ctx.agregados === true && AGREGADOS.has(base)) || (ctx.politica === true && nome.length === 1 && FUNCOES_DE_POLITICA.has(base));
      if (!ok) {
        recusa(`${onde}: a função "${nome.join('.')}" não é permitida (só ${[...FUNCOES].join(', ')}${ctx.politica ? ' e as funções de acesso das políticas' : ''}, sem esquema). Função que grava ou lê tabelas roda como dono do banco e é uma porta para os dados fechados.`);
      }
      for (const x of v.args ?? []) expressao(x, ctx, onde);
      return;
    }
    case 'SubLink':
      return recusa(`${onde}: subconsulta (SELECT dentro da expressão) não é permitida`);
    default:
      return recusa(`${onde}: expressão do tipo ${t} não é permitida`);
  }
}

/** Política permissiva: true, 1=1 ou 'a'='a'. */
function permissiva(no: No): boolean {
  if (!no) return false;
  const [t, v] = tipoDe(no);
  if (t === 'A_Const') return v.boolval?.boolval === true;
  if (t === 'TypeCast') return permissiva(v.arg);
  if (t === 'A_Expr' && v.kind === 'AEXPR_OP' && v.name?.[0]?.String?.sval === '=' && v.lexpr && v.rexpr) {
    const [lt, lv] = tipoDe(v.lexpr);
    const [rt, rv] = tipoDe(v.rexpr);
    return lt === 'A_Const' && rt === 'A_Const' && JSON.stringify(stripLocation(lv)) === JSON.stringify(stripLocation(rv));
  }
  return false;
}
const stripLocation = (o: No): No => JSON.parse(JSON.stringify(o, (k, x) => (k === 'location' ? undefined : x)));

// ------------------------------------------------------------------ comandos

interface Achado {
  tipo: string;
  o_que: string;
  avisos?: string[];
  criou?: string;
  ligouRls?: string;
}

function constraint(c: No, onde: string): { padrao?: boolean } {
  so(c, ['contype', 'conname', 'deferrable', 'initdeferred', 'is_enforced', 'initially_valid', 'skip_validation', 'raw_expr', 'generated_when', 'generated_kind', 'keys', 'including', 'nulls_not_distinct', 'pktable', 'fk_attrs', 'pk_attrs', 'fk_matchtype', 'fk_upd_action', 'fk_del_action', 'fk_del_set_cols'], `${onde} (restrição)`);
  switch (c.contype) {
    case 'CONSTR_NULL':
    case 'CONSTR_NOTNULL':
      return {};
    case 'CONSTR_DEFAULT':
      if (!c.raw_expr) recusa(`${onde}: DEFAULT sem valor`);
      expressao(c.raw_expr, { colunas: false }, `${onde} (DEFAULT)`);
      return { padrao: true };
    case 'CONSTR_IDENTITY':
      return { padrao: true };
    case 'CONSTR_GENERATED':
      expressao(c.raw_expr, { colunas: true }, `${onde} (coluna gerada)`);
      return { padrao: true };
    case 'CONSTR_CHECK':
      expressao(c.raw_expr, { colunas: true }, `${onde} (CHECK)`);
      return {};
    case 'CONSTR_PRIMARY':
    case 'CONSTR_UNIQUE':
      strings(c.keys, onde);
      return {};
    case 'CONSTR_FOREIGN':
      relacao(c.pktable, `${onde} (REFERENCES)`);
      return {};
    default:
      return recusa(`${onde}: restrição do tipo ${c.contype} não é permitida`);
  }
}

function colunaDef(cd: No, onde: string): { avisos: string[]; nome: string } {
  so(cd, ['colname', 'typeName', 'is_local', 'constraints'], `${onde} (coluna)`);
  tipoPermitido(cd.typeName, `${onde} (coluna ${cd.colname})`);
  const avisos: string[] = [];
  let naoNulo = false;
  let comPadrao = false;
  for (const x of cd.constraints ?? []) {
    const [t, c] = tipoDe(x);
    if (t !== 'Constraint') recusa(`${onde}: restrição inesperada`);
    const r = constraint(c, `${onde} (coluna ${cd.colname})`);
    if (c.contype === 'CONSTR_NOTNULL') naoNulo = true;
    if (r.padrao) comPadrao = true;
  }
  if (/serial$/.test(strings(cd.typeName.names, onde).at(-1) ?? '')) comPadrao = true;
  if (naoNulo && !comPadrao) avisos.push(`a coluna ${cd.colname} é NOT NULL sem DEFAULT: falha se a tabela já tiver linhas`);
  return { avisos, nome: cd.colname };
}

function criarTabela(s: No): Achado[] {
  so(s, ['relation', 'tableElts', 'if_not_exists', 'oncommit'], 'CREATE TABLE');
  if (s.oncommit !== undefined && s.oncommit !== 'ONCOMMIT_NOOP') recusa('CREATE TABLE: ON COMMIT não é permitido');
  const t = relacao(s.relation, 'CREATE TABLE');
  if (!Array.isArray(s.tableElts) || !s.tableElts.length) recusa(`CREATE TABLE só na forma "CREATE TABLE ${t} ( coluna tipo, … )", com ao menos uma coluna`);
  for (const el of s.tableElts) {
    const [et, ev] = tipoDe(el);
    if (et === 'ColumnDef') colunaDef(ev, `CREATE TABLE ${t}`);
    else if (et === 'Constraint') constraint(ev, `CREATE TABLE ${t}`);
    else if (et === 'TableLikeClause') {
      so(ev, ['relation', 'options'], 'CREATE TABLE (LIKE)');
      relacao(ev.relation, 'CREATE TABLE (LIKE)');
    } else recusa(`CREATE TABLE ${t}: elemento ${et} não é permitido`);
  }
  return [{ tipo: 'CREATE TABLE', o_que: `Cria a tabela ${t}${s.if_not_exists ? ' (se ainda não existir)' : ''}`, criou: t }];
}

function alterarTabela(s: No): Achado[] {
  so(s, ['relation', 'cmds', 'objtype', 'missing_ok'], 'ALTER TABLE');
  if (s.objtype !== 'OBJECT_TABLE') recusa('ALTER só em tabela (não em view, índice ou sequência)');
  const t = relacao(s.relation, 'ALTER TABLE');
  return (s.cmds ?? []).map((cmd: No): Achado => {
    const [ct, c] = tipoDe(cmd);
    if (ct !== 'AlterTableCmd') recusa('ALTER TABLE: comando inesperado');
    so(c, ['subtype', 'name', 'def', 'behavior', 'missing_ok'], 'ALTER TABLE');
    if (c.behavior !== undefined && c.behavior !== 'DROP_RESTRICT') recusa('ALTER TABLE: CASCADE não é permitido');
    const onde = `ALTER TABLE ${t}`;
    switch (c.subtype) {
      case 'AT_AddColumn': {
        const [, cd] = tipoDe(c.def);
        const r = colunaDef(cd, onde);
        return { tipo: 'ALTER TABLE ADD COLUMN', o_que: `Acrescenta a coluna ${r.nome} na tabela ${t}${c.missing_ok ? ' (se ainda não existir)' : ''}`, avisos: r.avisos };
      }
      case 'AT_AddConstraint': {
        const [, k] = tipoDe(c.def);
        if (!['CONSTR_CHECK', 'CONSTR_PRIMARY', 'CONSTR_UNIQUE', 'CONSTR_FOREIGN'].includes(k.contype)) recusa(`${onde}: só CHECK, PRIMARY KEY, UNIQUE e FOREIGN KEY`);
        constraint(k, onde);
        const quais: Record<string, string> = { CONSTR_CHECK: 'check', CONSTR_PRIMARY: 'primary key', CONSTR_UNIQUE: 'unique', CONSTR_FOREIGN: 'foreign key' };
        return { tipo: 'ALTER TABLE ADD CONSTRAINT', o_que: `Acrescenta uma restrição${k.conname ? ` "${k.conname}"` : ''} (${quais[k.contype]}) na tabela ${t}` };
      }
      case 'AT_ColumnDefault':
        if (!c.def) recusa(`${onde}: DROP DEFAULT não existe por aqui (DROP); para trocar o valor padrão use SET DEFAULT`);
        expressao(c.def, { colunas: false }, `${onde} (DEFAULT)`);
        return { tipo: 'ALTER COLUMN SET DEFAULT', o_que: `Muda o valor padrão da coluna ${c.name} da tabela ${t} (só vale para linhas novas)` };
      case 'AT_SetNotNull':
        return { tipo: 'ALTER COLUMN SET NOT NULL', o_que: `Torna a coluna ${c.name} da tabela ${t} obrigatória`, avisos: [`SET NOT NULL falha se já houver linha com ${c.name} vazio`] };
      case 'AT_AlterColumnType': {
        const [, cd] = tipoDe(c.def);
        so(cd, ['typeName', 'raw_default', 'colname'], `${onde} (tipo)`);
        if (cd.raw_default !== undefined) recusa(`${onde}: USING não é permitido (reescreve os valores da coluna): para converter, crie uma coluna nova`);
        tipoPermitido(cd.typeName, `${onde} (tipo)`);
        return { tipo: 'ALTER COLUMN TYPE', o_que: `Muda o TIPO da coluna ${c.name} da tabela ${t}`, avisos: [`mudar o tipo de ${t}.${c.name} pode FALHAR se os dados que já existem não couberem no tipo novo (e reescreve a tabela inteira); se falhar nada muda`] };
      }
      case 'AT_EnableRowSecurity':
        return { tipo: 'ALTER TABLE ENABLE RLS', o_que: `Liga a segurança por linha (RLS) na tabela ${t}`, ligouRls: t };
      case 'AT_ForceRowSecurity':
        return { tipo: 'ALTER TABLE FORCE RLS', o_que: `Faz a RLS valer também para o dono da tabela ${t}` };
      case 'AT_DisableRowSecurity':
      case 'AT_NoForceRowSecurity':
        return recusa(`desligar a segurança por linha (RLS) de ${t} não é permitido por aqui: ela é o que decide quem vê cada linha`);
      default:
        return recusa(`${onde}: a ação ${String(c.subtype).replace('AT_', '')} não é permitida. ${ACEITO}`);
    }
  });
}

function criarIndice(s: No): Achado[] {
  if (s.concurrent) recusa('CREATE INDEX CONCURRENTLY não funciona aqui (o servidor roda dentro de uma transação): use CREATE INDEX');
  so(s, ['idxname', 'relation', 'accessMethod', 'indexParams', 'indexIncludingParams', 'whereClause', 'unique', 'if_not_exists', 'nulls_not_distinct'], 'CREATE INDEX');
  const t = relacao(s.relation, 'CREATE INDEX');
  if (s.accessMethod !== undefined && !METODOS_DE_INDICE.has(s.accessMethod)) recusa(`CREATE INDEX: método ${s.accessMethod} não permitido`);
  for (const p of [...(s.indexParams ?? []), ...(s.indexIncludingParams ?? [])]) {
    const [, ip] = tipoDe(p);
    so(ip, ['name', 'expr', 'ordering', 'nulls_ordering'], 'CREATE INDEX');
    if (ip.expr) expressao(ip.expr, { colunas: true }, 'CREATE INDEX (expressão)');
  }
  if (s.whereClause) expressao(s.whereClause, { colunas: true }, 'CREATE INDEX (WHERE)');
  return [{ tipo: 'CREATE INDEX', o_que: `Cria o índice${s.unique ? ' ÚNICO' : ''}${s.idxname ? ` ${s.idxname}` : ''} na tabela ${t}` }];
}

const SELECT_CHAVES = ['targetList', 'fromClause', 'whereClause', 'groupClause', 'havingClause', 'sortClause', 'limitCount', 'limitOffset', 'limitOption', 'op'];

function selecionar(q: No): void {
  const [t, s] = tipoDe(q);
  if (t !== 'SelectStmt') recusa('a view precisa ser um SELECT');
  so(s, SELECT_CHAVES, 'a consulta da view');
  if (s.op !== undefined && s.op !== 'SETOP_NONE') recusa('a view não pode usar UNION/INTERSECT/EXCEPT');
  const ctx: Ctx = { colunas: true, agregados: true };
  for (const r of s.targetList ?? []) {
    const [, rt] = tipoDe(r);
    so(rt, ['name', 'val'], 'a consulta da view');
    if (rt.val) expressao(rt.val, ctx, 'a consulta da view');
  }
  const origem = (n: No): void => {
    const [ot, ov] = tipoDe(n);
    if (ot === 'RangeVar') relacao(ov, 'a consulta da view');
    else if (ot === 'JoinExpr') {
      so(ov, ['jointype', 'isNatural', 'larg', 'rarg', 'usingClause', 'quals', 'alias'], 'a consulta da view (JOIN)');
      origem(ov.larg);
      origem(ov.rarg);
      if (ov.quals) expressao(ov.quals, ctx, 'a consulta da view (ON)');
    } else recusa(`a consulta da view: ${ot} não é permitido (só tabelas e JOIN entre tabelas)`);
  };
  for (const f of s.fromClause ?? []) origem(f);
  for (const k of ['whereClause', 'havingClause', 'limitCount', 'limitOffset'] as const) if (s[k]) expressao(s[k], ctx, 'a consulta da view');
  for (const g of s.groupClause ?? []) expressao(g, ctx, 'a consulta da view');
  for (const o of s.sortClause ?? []) {
    const [, sb] = tipoDe(o);
    so(sb, ['node', 'sortby_dir', 'sortby_nulls'], 'a consulta da view');
    expressao(sb.node, ctx, 'a consulta da view');
  }
}

/** Valor de uma opção `x = true/on/1` do parser (String, Boolean ou Integer). */
function booleano(arg: No): boolean {
  const [t, v] = tipoDe(arg);
  if (t === 'String') return ['true', 'on', '1', 'yes'].includes(String(v.sval).toLowerCase());
  if (t === 'Boolean') return v.boolval === true;
  if (t === 'Integer') return v.ival === 1;
  return false;
}

function criarView(s: No): Achado[] {
  so(s, ['view', 'aliases', 'query', 'replace', 'options', 'withCheckOption'], 'CREATE VIEW');
  if (s.withCheckOption !== undefined && s.withCheckOption !== 'NO_CHECK_OPTION') recusa('CREATE VIEW: WITH CHECK OPTION não é permitido');
  const v = relacao(s.view, 'CREATE VIEW');
  // a view roda com os direitos de quem a criou (que enxerga tudo); sem security_invoker ela PASSA POR CIMA da segurança por linha
  let invoker = false;
  for (const o of s.options ?? []) {
    const [, d] = tipoDe(o);
    so(d, ['defname', 'arg', 'defaction', 'defnamespace'], 'CREATE VIEW');
    if (d.defnamespace) recusa('CREATE VIEW: opção com namespace não é permitida');
    if (d.defname === 'security_invoker') {
      const ligado = !d.arg || booleano(d.arg);
      if (!ligado) recusa(`a view ${v} precisa de security_invoker = true`);
      invoker = true;
    } else if (d.defname !== 'security_barrier') recusa(`CREATE VIEW: a opção ${d.defname} não é permitida`);
  }
  if (!invoker) {
    recusa(`a view ${v} precisa de WITH (security_invoker = true) logo depois do nome: sem isso ela ignora a segurança por linha e mostra a todos os usuários logados o que só alguns podem ver. Exemplo: CREATE VIEW ${v} WITH (security_invoker = true) AS SELECT ...`);
  }
  selecionar(s.query);
  return [{ tipo: 'CREATE VIEW', o_que: `${s.replace ? 'Cria ou SUBSTITUI' : 'Cria'} a view ${v} (com as permissões de quem consulta)` }];
}

function papeis(lista: No, onde: string, obrigatorio: boolean): string[] {
  if (!lista) {
    if (obrigatorio) recusa(`${onde} precisa dizer para quem vale: acrescente "TO authenticated" (usuários logados) — sem isso valeria também para quem não fez login`);
    return [];
  }
  return lista.map((r: No) => {
    const [, rv] = tipoDe(r);
    so(rv, ['roletype', 'rolename'], onde);
    if (rv.roletype === 'ROLESPEC_PUBLIC') recusa(`${onde} precisa dizer para quem vale: use "TO authenticated" (usuários logados) — sem isso, ou com PUBLIC, valeria também para quem não fez login`);
    if (rv.roletype !== 'ROLESPEC_CSTRING' || !PAPEIS.has(rv.rolename)) recusa(`${onde}: use "TO authenticated" e/ou "TO service_role" (recebi ${rv.rolename ?? String(rv.roletype).replace('ROLESPEC_', '')})`);
    return rv.rolename as string;
  });
}

function politica(tipoStmt: string, s: No): Achado[] {
  so(s, ['policy_name', 'table', 'cmd_name', 'permissive', 'roles', 'qual', 'with_check'], 'POLICY');
  const t = relacao(s.table, 'POLICY');
  papeis(s.roles, `a política ${s.policy_name}`, tipoStmt === 'CreatePolicyStmt');
  const ctx: Ctx = { colunas: true, politica: true };
  if (s.qual) expressao(s.qual, ctx, `a política ${s.policy_name} (USING)`);
  if (s.with_check) expressao(s.with_check, ctx, `a política ${s.policy_name} (WITH CHECK)`);
  const avisos = permissiva(s.qual) || permissiva(s.with_check) ? [`a política ${s.policy_name} é permissiva (true, 1=1…): libera TODAS as linhas de ${t} para todo usuário logado`] : [];
  const criar = tipoStmt === 'CreatePolicyStmt';
  return [{ tipo: `${criar ? 'CREATE' : 'ALTER'} POLICY`, o_que: `${criar ? 'Cria' : 'Altera'} a política ${s.policy_name} da tabela ${t} (regra de quem vê/grava cada linha)`, avisos }];
}

const OBJETOS_DE_COMENTARIO: Record<string, { quem: string; max: number }> = {
  OBJECT_TABLE: { quem: 'da tabela', max: 1 },
  OBJECT_INDEX: { quem: 'do índice', max: 1 },
  OBJECT_VIEW: { quem: 'da view', max: 1 },
  OBJECT_SEQUENCE: { quem: 'da sequência', max: 1 },
  OBJECT_COLUMN: { quem: 'da coluna', max: 2 },
  OBJECT_POLICY: { quem: 'da política', max: 2 },
  OBJECT_TABCONSTRAINT: { quem: 'da restrição', max: 2 },
};

function comentario(s: No): Achado[] {
  so(s, ['objtype', 'object', 'comment'], 'COMMENT');
  const o = OBJETOS_DE_COMENTARIO[s.objtype];
  if (!o) recusa('COMMENT só em tabela, coluna, índice, view, sequência, política e restrição');
  const [, l] = tipoDe(s.object);
  const nomes = strings(l.items, 'COMMENT');
  if (nomes.length > o.max && (nomes.length !== o.max + 1 || nomes[0] !== 'public')) recusa(`COMMENT: só o esquema "public" é permitido (recebi "${nomes.join('.')}")`);
  for (const n of nomes) semFechada(n, 'COMMENT');
  return [{ tipo: 'COMMENT', o_que: `Escreve o comentário ${o.quem} ${nomes.join('.')}` }];
}

function conceder(s: No): Achado[] {
  so(s, ['is_grant', 'targtype', 'objtype', 'objects', 'privileges', 'grantees', 'grant_option', 'behavior'], 'GRANT/REVOKE');
  const verbo = s.is_grant ? 'GRANT' : 'REVOKE';
  if (s.targtype !== 'ACL_TARGET_OBJECT' || (s.objtype !== 'OBJECT_TABLE' && s.objtype !== 'OBJECT_SEQUENCE')) {
    recusa(`${verbo} só em tabela ou sequência do esquema public (sem "ALL TABLES IN SCHEMA", sem esquema, sem função)`);
  }
  if (s.grant_option) recusa(`${verbo}: WITH GRANT OPTION não é permitido`);
  if (s.behavior !== undefined && s.behavior !== 'DROP_RESTRICT') recusa(`${verbo}: CASCADE não é permitido`);
  if (!s.privileges?.length) recusa(`${verbo} precisa dizer os privilégios: SELECT, INSERT, UPDATE, DELETE (ou USAGE em sequência); "ALL" não é permitido`);
  const privs: string[] = s.privileges.map((p: No) => {
    const [, pv] = tipoDe(p);
    so(pv, ['priv_name'], verbo);
    if (!PRIVILEGIOS.has(pv.priv_name)) recusa(`${verbo}: o privilégio ${String(pv.priv_name).toUpperCase()} não é permitido (só SELECT, INSERT, UPDATE, DELETE, USAGE)`);
    return String(pv.priv_name).toUpperCase();
  });
  const tabelas = (s.objects ?? []).map((o: No) => relacao(o, verbo));
  const para = papeis(s.grantees, verbo, true);
  const grant = s.is_grant === true;
  return [
    {
      tipo: verbo,
      o_que: `${grant ? 'Dá' : 'Tira'} ${privs.join(', ')} em ${tabelas.join(', ')} ${grant ? 'a' : 'de'} ${para.join(', ')}`,
      avisos: para.includes('authenticated') ? [`${verbo} em ${tabelas.join(', ')} vale para TODOS os usuários logados (authenticated); quem vê cada linha é decidido pela RLS`] : [],
    },
  ];
}

function comando(no: No): Achado[] {
  const [t, s] = tipoDe(no);
  switch (t) {
    case 'CreateStmt': return criarTabela(s);
    case 'AlterTableStmt': return alterarTabela(s);
    case 'IndexStmt': return criarIndice(s);
    case 'ViewStmt': return criarView(s);
    case 'CreatePolicyStmt':
    case 'AlterPolicyStmt': return politica(t, s);
    case 'CommentStmt': return comentario(s);
    case 'GrantStmt': return conceder(s);
    default:
      return recusa(`${POR_TIPO_DE_COMANDO[t] ?? `o comando ${t} não é permitido por aqui`}. ${ACEITO}`);
  }
}

// ------------------------------------------------------------------ entrada

/**
 * Escritas de texto que o parser entende mas a 2ª barreira do banco (admin_sql, migration 071) recusa de propósito, porque cada regex
 * lê diferente do Postgres: comentário, nome entre aspas duplas, $tag$…$tag$, E'…' e U&'…'. Recusar AQUI evita aprovar no 1º passo
 * o que o banco vai recusar no 2º. (O parser as resolveria; a política é: o que não precisa existir não existe.)
 */
function marcasDeTexto(sql: string): void {
  if (sql.includes('--') || sql.includes('/*')) recusa('comentário (-- ou /* */) não é permitido por aqui (nem dentro de texto): para documentar use COMMENT ON');
  if (sql.includes('"')) recusa('nome entre aspas duplas ("…") não é permitido por aqui: escreva tabelas e colunas em minúsculas, com letras, números e "_", sem aspas');
  if (sql.includes('$')) recusa('o caractere "$" (texto entre $$ ou $tag$) não é permitido por aqui: use aspas simples para texto');
  if (/(^|[^a-z0-9_$])e'/i.test(sql) || /(^|[^a-z0-9_$])u&\s*'/i.test(sql)) recusa("texto E'…' ou U&'…' (com escapes) não é permitido por aqui: use aspas simples comuns");
}

/** Confere o SQL e devolve o que ele faz. Lança `ErroEstrutura` (mensagem em português, com o que reescrever) quando recusa. */
export function analisarEstrutura(sqlBruto: unknown, opcoes: { semMarcas?: boolean } = {}): AnaliseEstrutura {
  if (typeof sqlBruto !== 'string' || !sqlBruto.trim()) recusa('sql vazio');
  const sql = sqlBruto.trim();
  if (sql.length > MAX_SQL) recusa(`sql grande demais (máximo ${MAX_SQL} caracteres): mande em partes`);
  // `semMarcas` existe só para os testes provarem que as regras por ÁRVORE sozinhas já barram os ataques (as marcas são uma 2ª camada)
  if (!opcoes.semMarcas) marcasDeTexto(sql);
  let arvore: No;
  try {
    arvore = parseSync(sql);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return recusa(`o SQL não é válido para o Postgres (${m.slice(0, 160)}). Corrija e mande de novo.`);
  }
  const stmts: No[] = (arvore.stmts ?? []).map((x: No) => x.stmt);
  if (!stmts.length) recusa('sql vazio (só comentário?)');
  if (stmts.length > MAX_COMANDOS) recusa(`comandos demais (${stmts.length}; máximo ${MAX_COMANDOS}): mande em partes`);
  for (const x of stmts) {
    if (!x) recusa('sql vazio');
  }
  const achados: Achado[] = [];
  for (const st of stmts) {
    achados.push(...comando(st));
    varrerFechadas(st, 'o comando');
  }
  const avisos = achados.flatMap((a) => a.avisos ?? []);
  const comRls = new Set(achados.flatMap((a) => (a.ligouRls ? [a.ligouRls] : [])));
  for (const a of achados) {
    if (a.criou && !comRls.has(a.criou)) {
      avisos.push(`a tabela ${a.criou} nasce SEM segurança por linha: todo usuário logado lê e grava todas as linhas dela. Junte neste mesmo pedido ALTER TABLE ${a.criou} ENABLE ROW LEVEL SECURITY e as CREATE POLICY, ou faça logo em seguida.`);
    }
  }
  return { sql, comandos: achados.map((a, i) => ({ n: i + 1, tipo: a.tipo, o_que: a.o_que })), avisos: [...new Set(avisos)] };
}
