/**
 * SQL LIVRE do sistema novo (RH/Caixa/Descontratos) pelo claude.ai: quem decide se um comando roda direto, pede confirmação ou é recusado.
 *
 * Este arquivo é IDÊNTICO nos dois repositórios (agente-dt: backend/src/mcp-remoto/sql-regras.ts; sistemas-dd: src/sql-regras.ts).
 * Um teste de cada lado confere o hash do arquivo e roda o MESMO conjunto de casos (sql-casos.json). Mudou aqui, mude lá igualzinho.
 * Só importa `libpg-query`; sem import local, sem enum, sem parameter property (roda no Node com type-stripping e no tsc).
 *
 * Por que parser e não regex: texto de SQL tem aspas, $tag$, comentário, e'\'' e quebras que cada regex lê de um jeito e o Postgres de outro
 * (isso já furou 3 rodadas de revisão do PR #175). Aqui o SQL é lido pelo PARSER DO POSTGRES (libpg-query = o código do próprio Postgres em WASM)
 * e as regras olham a ÁRVORE, não o texto:
 *   - lista PERMITIDA de comandos; o que não está nela é recusado (default-deny);
 *   - toda expressão (default, check, índice, WHERE, política, view, corpo de função) passa por um verificador que só conhece nós
 *     inofensivos: funções só da lista (sem esquema), operadores só da lista, tipos só da lista;
 *   - nome de tabela/coluna/esquema vem já resolvido pelo parser (aspas, maiúsculas, `"auth".x`, `u&"…"` viram o nome de verdade);
 *   - cada comando é executado SOZINHO, pelo trecho que o parser delimitou, e o trecho é lido de novo e tem de dar a mesma árvore.
 *
 * Três respostas: roda direto (`decisao: 'direto'`), exige confirmação humana (`'confirmar'`: só o que destrói) ou é recusado
 * (lança `ErroSql`: nem com confirmação).
 */
import { loadModule, parseSync, parsePlPgSQLSync } from 'libpg-query';

await loadModule();

export const MAX_SQL = 100_000;
export const MAX_COMANDOS = 50;

export class ErroSql extends Error {}

export type Acao = 'direto' | 'confirmar';

export interface ComandoSql {
  /** número do comando no pedido (1, 2, 3…); um ALTER TABLE com várias ações repete o número */
  n: number;
  tipo: string;
  acao: Acao;
  o_que: string;
  /** tabela, view materializada ou função que ESTE comando cria (o servidor ajusta as permissões logo depois dele) */
  criou?: string;
  matview?: string;
  funcao?: string;
}

export interface AnaliseSql {
  /** o SQL como veio */
  sql: string;
  /** cada comando, no texto exato que o parser delimitou (é isto que se executa, um por vez) */
  trechos: string[];
  comandos: ComandoSql[];
  /** 'confirmar' se QUALQUER comando destrói */
  decisao: Acao;
  /** algum comando muda estrutura (tabela, coluna, índice, política, função…): antes dele, snapshot do esquema */
  mudaEstrutura: boolean;
  /** algum comando grava dados (INSERT, UPDATE, DELETE, TRUNCATE) */
  mudaDados: boolean;
  /** antes de executar, o servidor tira o snapshot (esquema e/ou linhas): mudança de estrutura ou UPDATE/DELETE/TRUNCATE/DROP */
  precisaSnapshot: boolean;
  /** tabelas existentes cujas LINHAS entram no snapshot (UPDATE, DELETE, TRUNCATE, ALTER, DROP, ON CONFLICT DO UPDATE) */
  tabelasParaCopiar: string[];
  /** tabelas criadas neste pedido (o servidor liga a segurança por linha nelas se o pedido não ligar) */
  tabelasCriadas: string[];
  /** views materializadas criadas (o servidor tira o acesso dos usuários logados: view materializada não tem segurança por linha) */
  matviewsCriadas: string[];
  /** funções criadas (o servidor tira o EXECUTE de PUBLIC/anon e dá a authenticated e service_role) */
  funcoesCriadas: string[];
  /** alvos de UPDATE/DELETE, na ordem dos comandos (o servidor compara as linhas afetadas com o tamanho da tabela) */
  alvosDeEscrita: Array<{ n: number; tabela: string; op: 'update' | 'delete' }>;
  renomeia: boolean;
  avisos: string[];
}

// ------------------------------------------------------------------ listas

/**
 * O que é fechado e o que é "função de acesso" depende do SISTEMA (cada um tem o seu banco):
 *  - `totais`: fechadas por inteiro — nem ler dentro de outro comando. Registro de auditoria, usuários (papel só por sistemas_usuario) e tudo `admin_*`/`pg_*`.
 *  - `estrutura`: fechadas para mudar a ESTRUTURA (ALTER, DROP, índice, política, gatilho, GRANT, TRUNCATE…); os DADOS delas podem ser lidos e gravados.
 *  - `acesso`: auxiliares de acesso do próprio sistema (STABLE, só dizem quem é o usuário). Em política, consulta, WHERE e corpo de função.
 */
export type SistemaSql = 'rh' | 'dsc';
interface Perfil {
  totais: string[];
  estrutura: string[];
  acesso: Set<string>;
}
const PERFIS: Record<SistemaSql, Perfil> = {
  rh: {
    totais: ['rh_usuarios', 'rh_log'],
    estrutura: ['rh_docs', 'rh_site', 'rh_site_stage', 'rh_staging'],
    acesso: new Set([
      'rh_admin', 'rh_papel', 'meu_perfil', 'meu_colaborador', 'meu_tenant', 'caixa_gestor', 'caixa_minha_unidade', 'caixa_pode', 'rh_fin_le',
      'rh_fin_escreve', 'rh_fin_ok', 'rh_socio_colab_ok', 'rh_socio_doc_ok', 'rh_socio_emp', 'rh_socio_fin', 'rh_socio_slug', 'rh_socio_un', 'rh_socio_vaga_ok',
    ]),
  },
  // Descontratos + Ficha: o motor de documentos (dsc_docs) e as páginas servidas pelo banco (dsc_site, site_parts, site_assets) são o núcleo
  dsc: {
    totais: ['dsc_usuarios'],
    estrutura: ['dsc_docs', 'dsc_site', 'site_parts', 'site_assets'],
    acesso: new Set(['dsc_admin', 'dsc_papel', 'dsc_unidade']),
  },
};
/** O perfil do comando que está sendo conferido (a conferência é síncrona; `classificar` põe e tira). */
let perfil: Perfil = PERFIS.rh;

const ESQUEMAS_PROIBIDOS = new Set(['auth', 'storage', 'information_schema', 'pg_catalog', 'pg_toast', 'pg_temp']);

const comPrefixo = (nome: string, base: string): boolean => nome === base || nome.startsWith(`${base}_`);
export const fechadaTotal = (nome: string): boolean => perfil.totais.some((f) => comPrefixo(nome, f)) || nome.startsWith('admin_') || nome.startsWith('pg_');
export const fechadaEstrutura = (nome: string): boolean => perfil.estrutura.some((f) => comPrefixo(nome, f));

/** Papéis da aplicação a quem se pode dar acesso. `anon`/PUBLIC (sem login) nunca. */
const PAPEIS = new Set(['authenticated', 'service_role', 'mcp_leitor']);
const PAPEIS_DE_POLITICA = new Set(['authenticated', 'service_role']);
const METODOS_DE_INDICE = new Set(['btree', 'hash', 'gin', 'gist', 'brin']);
const NOME_NOVO = /^[a-z_][a-z0-9_]{0,62}$/;

/** Funções nativas inofensivas (sem esquema, ou pg_catalog.x). Nenhuma lê arquivo, olha o ambiente, executa texto ou fala com a rede. */
const FUNCOES = new Set([
  'now', 'gen_random_uuid', 'lower', 'upper', 'length', 'char_length', 'character_length', 'btrim', 'ltrim', 'rtrim', 'trim', 'abs', 'round', 'floor',
  'ceil', 'ceiling', 'substr', 'substring', 'concat', 'concat_ws', 'replace', 'left', 'right', 'date_trunc', 'date_part', 'extract', 'to_char', 'timezone',
  'position', 'strpos', 'split_part', 'initcap', 'lpad', 'rpad', 'reverse', 'translate', 'regexp_replace', 'md5', 'mod', 'power', 'sqrt',
  'trunc', 'sign', 'to_number', 'to_date', 'to_timestamp', 'make_date', 'make_timestamptz', 'age', 'date', 'isfinite', 'clock_timestamp', 'random',
  'jsonb_build_object', 'jsonb_build_array', 'json_build_object', 'json_build_array', 'jsonb_set', 'jsonb_insert', 'jsonb_strip_nulls', 'jsonb_typeof',
  'jsonb_array_length', 'jsonb_extract_path', 'jsonb_extract_path_text', 'jsonb_pretty', 'to_jsonb', 'to_json', 'row_to_json', 'jsonb_object_keys',
  'array_length', 'array_to_string', 'string_to_array', 'array_append', 'array_prepend', 'array_cat', 'array_remove', 'array_position', 'cardinality',
  'nextval', 'currval', 'setval',
]);
/** Agregados e funções de janela. */
const AGREGADOS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'bool_and', 'bool_or', 'every', 'string_agg', 'array_agg', 'jsonb_agg', 'json_agg', 'jsonb_object_agg',
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value',
]);
/** Funções que devolvem linhas, só no FROM. */
const FUNCOES_DE_TABELA = new Set(['generate_series', 'unnest', 'jsonb_array_elements', 'jsonb_array_elements_text', 'jsonb_each', 'jsonb_each_text', 'string_to_table', 'regexp_split_to_table']);
const OPERADORES = new Set([
  '=', '<>', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '^', '||', '~~', '~~*', '!~~', '!~~*', '~', '~*', '!~', '!~*', '->', '->>', '#>', '#>>',
  '@>', '<@', '&&', '?', '?|', '?&', '&', '|', '#', '<<', '>>',
]);
const TIPOS = new Set([
  'text', 'varchar', 'bpchar', 'char', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'bool', 'date', 'time', 'timetz', 'timestamp',
  'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'bytea', 'serial', 'smallserial', 'bigserial',
]);
const SVF_OK = new Set(['SVFOP_CURRENT_DATE', 'SVFOP_CURRENT_TIME', 'SVFOP_CURRENT_TIME_N', 'SVFOP_CURRENT_TIMESTAMP', 'SVFOP_CURRENT_TIMESTAMP_N', 'SVFOP_LOCALTIME', 'SVFOP_LOCALTIME_N', 'SVFOP_LOCALTIMESTAMP', 'SVFOP_LOCALTIMESTAMP_N']);
const KINDS = new Set([
  'AEXPR_OP', 'AEXPR_OP_ANY', 'AEXPR_OP_ALL', 'AEXPR_IN', 'AEXPR_LIKE', 'AEXPR_ILIKE', 'AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN', 'AEXPR_BETWEEN_SYM',
  'AEXPR_NOT_BETWEEN_SYM', 'AEXPR_NULLIF', 'AEXPR_DISTINCT', 'AEXPR_NOT_DISTINCT', 'AEXPR_SIMILAR',
]);

const ACEITO =
  'Direto: CREATE TABLE/TABLE AS/VIEW/MATERIALIZED VIEW/INDEX/FUNCTION/TRIGGER/POLICY/TYPE/SEQUENCE, ALTER TABLE (colunas, restrições, RLS), COMMENT, GRANT para authenticated/service_role, ' +
  'renomear, INSERT, UPDATE e DELETE com WHERE. Com confirmação: DROP, TRUNCATE, UPDATE/DELETE sem WHERE, ALTER … DROP COLUMN/CONSTRAINT, REVOKE, desligar RLS.';

const POR_TIPO_DE_COMANDO: Record<string, string> = {
  CopyStmt: 'COPY (de ou para arquivo) não existe por aqui',
  SelectStmt: 'consultar dados não passa por aqui: para ler use sistemas_consultar',
  MergeStmt: 'MERGE não existe por aqui: use INSERT … ON CONFLICT ou UPDATE com WHERE',
  DoStmt: 'DO (SQL dinâmico) não é permitido',
  CallStmt: 'CALL não é permitido',
  RuleStmt: 'CREATE RULE não é permitido (reescreve comandos de outros usuários)',
  VariableSetStmt: 'SET/RESET não é permitido por aqui (nem trocar de papel)',
  VariableShowStmt: 'SHOW não é permitido por aqui',
  TransactionStmt: 'BEGIN/COMMIT/ROLLBACK/SAVEPOINT não são permitidos: o servidor já roda o pedido todo como uma transação só',
  AlterOwnerStmt: 'mudar o dono não é permitido por aqui',
  CreateRoleStmt: 'criar papel/usuário do banco não é permitido por aqui',
  AlterRoleStmt: 'alterar papel/usuário do banco não é permitido por aqui',
  AlterRoleSetStmt: 'alterar papel/usuário do banco não é permitido por aqui',
  DropRoleStmt: 'apagar papel/usuário do banco não é permitido por aqui',
  GrantRoleStmt: 'GRANT de papel para papel não é permitido por aqui',
  AlterDefaultPrivilegesStmt: 'ALTER DEFAULT PRIVILEGES não é permitido por aqui',
  CreateSchemaStmt: 'criar esquema não é permitido por aqui',
  CreateExtensionStmt: 'criar extensão não é permitido por aqui',
  AlterExtensionStmt: 'extensões não são permitidas por aqui',
  VacuumStmt: 'VACUUM/ANALYZE não é permitido (roda fora de transação)',
  ClusterStmt: 'CLUSTER não é permitido (roda fora de transação)',
  ReindexStmt: 'REINDEX não é permitido por aqui',
  CheckPointStmt: 'CHECKPOINT não é permitido',
  ExecuteStmt: 'EXECUTE não é permitido',
  PrepareStmt: 'PREPARE não é permitido',
  DeallocateStmt: 'DEALLOCATE não é permitido',
  LockStmt: 'LOCK não é permitido por aqui',
  ExplainStmt: 'EXPLAIN não é permitido (com ANALYZE ele executa o comando)',
  NotifyStmt: 'NOTIFY não é permitido por aqui',
  ListenStmt: 'LISTEN não é permitido por aqui',
  CreateEventTrigStmt: 'gatilho de evento não é permitido',
  AlterSystemStmt: 'ALTER SYSTEM não é permitido',
  DiscardStmt: 'DISCARD não é permitido',
  LoadStmt: 'LOAD não é permitido',
  CreatedbStmt: 'criar banco não é permitido',
  DropdbStmt: 'apagar banco não é permitido',
  DropOwnedStmt: 'DROP OWNED não é permitido',
  ReassignOwnedStmt: 'REASSIGN OWNED não é permitido',
  SecLabelStmt: 'SECURITY LABEL não é permitido',
};

// ------------------------------------------------------------------ utilitários da árvore

// o JSON do parser é heterogêneo (cada nó é { NomeDoTipo: {...} }); por isso `any` aqui, e as regras conferem cada campo
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type No = any;

function recusa(msg: string): never {
  throw new ErroSql(msg);
}

/** `{ CreateStmt: {...} }` -> ['CreateStmt', {...}] */
function tipoDe(no: No): [string, No] {
  const k = no && typeof no === 'object' ? Object.keys(no) : [];
  if (k.length !== 1) recusa('estrutura de SQL inesperada');
  return [k[0]!, no[k[0]!]];
}

/** Só as chaves conhecidas (location e afins são ignoradas). Chave desconhecida = opção que não prevemos = recusa. */
function so(no: No, permitidas: string[], onde: string): void {
  if (!no || typeof no !== 'object') recusa(`${onde}: estrutura inesperada`);
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

const semLocation = (o: No): No => JSON.parse(JSON.stringify(o, (k, x) => (k === 'location' || k === 'stmt_location' || k === 'stmt_len' ? undefined : x)));

function fechadaMsg(nome: string, onde: string): never {
  return recusa(
    `${onde}: "${nome}" é tabela fechada: o registro de auditoria, a tabela de usuários (papel e unidade não se mudam por SQL), as tabelas admin_* e o catálogo do banco não se tocam por aqui, nem para ler dentro de outro comando.`,
  );
}

function semFechadaTotal(nome: string, onde: string): void {
  if (fechadaTotal(nome)) fechadaMsg(nome, onde);
}

function semFechadaEstrutura(nome: string, onde: string): void {
  semFechadaTotal(nome, onde);
  if (fechadaEstrutura(nome)) {
    recusa(`${onde}: "${nome}" é tabela do núcleo do sistema (RH/site): os DADOS dela podem ser lidos e gravados, mas a ESTRUTURA (coluna, política, índice, gatilho, GRANT, apagar) é só de quem administra o servidor.`);
  }
}

type Modo = 'ler' | 'escrever' | 'estrutura';

/** RangeVar -> nome da tabela. Só o esquema public; nunca tabela fechada. */
function relacao(rvBruto: No, onde: string, modo: Modo = 'ler'): string {
  // o parser entrega o RangeVar direto em alguns campos (relation, table, view) e embrulhado { RangeVar: … } em listas (FROM, GRANT)
  const v: No = rvBruto && rvBruto.RangeVar ? rvBruto.RangeVar : rvBruto;
  if (!v || typeof v !== 'object' || typeof v.relname !== 'string') recusa(`${onde}: esperava o nome de uma tabela`);
  so(v, ['catalogname', 'schemaname', 'relname', 'inh', 'relpersistence', 'alias'], `${onde} (nome da tabela)`);
  if (v.catalogname !== undefined) recusa(`${onde}: nome com banco na frente não é permitido`);
  if (v.schemaname !== undefined && v.schemaname !== 'public') recusa(`${onde}: só o esquema "public" é permitido (recebi "${v.schemaname}.${v.relname}")`);
  if (v.relpersistence !== undefined && v.relpersistence !== 'p') recusa(`${onde}: tabela temporária ou unlogged não faz sentido por aqui`);
  if (modo === 'estrutura') semFechadaEstrutura(v.relname, onde);
  else semFechadaTotal(v.relname, onde);
  return String(v.relname);
}

/** Nome de objeto NOVO (tabela, coluna, índice, política, gatilho, função, tipo, sequência): minúsculas, números e _. */
function nomeNovo(nome: unknown, oque: string, onde: string): string {
  if (typeof nome !== 'string' || !NOME_NOVO.test(nome)) recusa(`${onde}: o nome ${oque} "${String(nome).slice(0, 40)}" não vale: use minúsculas, números e "_", começando por letra (até 63 caracteres)`);
  semFechadaTotal(nome, onde);
  return nome;
}

/** Nome de objeto já existente, vindo de uma lista de Strings (`public.t`, `t`, `t.coluna`). Devolve os nomes sem o esquema. */
function nomesSemEsquema(itens: string[], max: number, onde: string): string[] {
  if (itens.length > max) {
    if (itens.length === max + 1 && itens[0] === 'public') itens = itens.slice(1);
    else recusa(`${onde}: só o esquema "public" é permitido (recebi "${itens.join('.')}")`);
  }
  for (const n of itens) semFechadaTotal(n, onde);
  return itens;
}

/** Qualquer menção a nome fechado ou a esquema proibido em QUALQUER lugar da árvore. Texto entre aspas simples não conta: é dado, não nome. */
function varrer(no: No, onde: string): void {
  if (Array.isArray(no)) {
    for (const x of no) varrer(x, onde);
    return;
  }
  if (!no || typeof no !== 'object') return;
  for (const [k, v] of Object.entries(no)) {
    if (k === 'String' && v && typeof v === 'object' && typeof (v as No).sval === 'string') {
      const s = String((v as No).sval);
      semFechadaTotal(s, onde);
      if (ESQUEMAS_PROIBIDOS.has(s)) recusa(`${onde}: o esquema/nome "${s}" não pode ser tocado por aqui (senhas, autenticação, arquivos e catálogo do banco são fechados)`);
    } else if (k === 'relname' && typeof v === 'string') semFechadaTotal(v, onde);
    else if (k === 'schemaname' && typeof v === 'string' && v !== 'public') recusa(`${onde}: só o esquema "public" é permitido (recebi "${v}")`);
    else if (k === 'catalogname') recusa(`${onde}: nome com banco na frente não é permitido`);
    // o nome do tipo/função/operador é conferido por quem os usa (lista própria); `pg_catalog.int4` é o que o parser escreve para `int`
    else if (k === 'funcname' || k === 'names' || k === 'name') continue;
    else varrer(v, onde);
  }
}

// ------------------------------------------------------------------ tipos e expressões

function tipoPermitido(tn: No, onde: string, extras: string[] = []): string {
  so(tn, ['names', 'typmods', 'typemod', 'arrayBounds', 'setof', 'pct_type'], `${onde} (tipo)`);
  if (tn.pct_type) recusa(`${onde}: tipo por %TYPE não é permitido`);
  const nomes = strings(tn.names, onde);
  const ultimo = nomes.at(-1) ?? '';
  const nativo = (nomes.length === 1 || (nomes.length === 2 && nomes[0] === 'pg_catalog')) && (TIPOS.has(ultimo) || extras.includes(ultimo));
  const meu = nomes.length === 2 && nomes[0] === 'public' && NOME_NOVO.test(ultimo) && !fechadaTotal(ultimo);
  if (!nativo && !meu) {
    recusa(`${onde}: o tipo "${nomes.join('.')}" não é permitido. Tipos aceitos: ${[...TIPOS].join(', ')}; um tipo criado por você escreva como public.nome`);
  }
  for (const m of tn.typmods ?? []) {
    const [mt, mv] = tipoDe(m);
    if (mt !== 'A_Const' || mv.ival === undefined) recusa(`${onde}: o tamanho do tipo precisa ser um número`);
  }
  return ultimo;
}

interface Ctx {
  colunas: boolean;
  /** agregados e funções de janela */
  agregados?: boolean;
  /** pode ter subconsulta e usar as funções de acesso (política, WHERE, consulta, corpo de função) */
  consulta?: boolean;
  /** $1, $2 (parâmetros de função) */
  params?: boolean;
}

const CONSULTA: Ctx = { colunas: true, agregados: true, consulta: true };

/** nextval('seq'): o nome da sequência é texto e vira objeto na hora de rodar — só nome simples, de tabela não fechada */
function nomeDeSequencia(args: No[], onde: string): void {
  const [t, v] = args.length === 1 || args.length === 2 ? tipoDe(args[0]) : ['', null];
  const ok = t === 'A_Const' && typeof v?.sval?.sval === 'string' && /^(public\.)?[a-z_][a-z0-9_]{0,62}$/.test(v.sval.sval) && !fechadaTotal(v.sval.sval.replace(/^public\./, ''));
  if (!ok) recusa(`${onde}: nextval/currval/setval aceita só o nome da sequência entre aspas simples (ex.: nextval('minha_seq')), sem esquema além de public e sem sequência fechada`);
}

/** Só nós inofensivos; função fora da lista e o que não conhecemos são recusados. */
function expressao(no: No, ctx: Ctx, onde: string): void {
  const [t, v] = tipoDe(no);
  switch (t) {
    case 'A_Const':
      if (v.bsval !== undefined) recusa(`${onde}: texto de bits não é permitido`);
      return;
    case 'SetToDefault':
      return;
    case 'ColumnRef':
      if (!ctx.colunas) recusa(`${onde}: aqui não cabe referência a coluna (só valor fixo)`);
      so(v, ['fields'], onde);
      for (const f of v.fields ?? []) {
        const [ft] = tipoDe(f);
        if (ft !== 'String' && ft !== 'A_Star') recusa(`${onde}: referência de coluna inesperada`);
      }
      return;
    case 'ParamRef':
      if (!ctx.params && !dentroDeFuncao) recusa(`${onde}: parâmetro ($1…) só dentro do corpo de uma função`);
      return;
    case 'TypeCast':
      so(v, ['arg', 'typeName'], onde);
      expressao(v.arg, ctx, onde);
      tipoPermitido(v.typeName, onde);
      return;
    case 'A_Expr': {
      so(v, ['kind', 'name', 'lexpr', 'rexpr', 'rexpr_list_start', 'rexpr_list_end'], onde);
      if (!KINDS.has(v.kind)) recusa(`${onde}: operador (${v.kind}) não permitido`);
      const nome = strings(v.name, onde);
      if (v.kind !== 'AEXPR_BETWEEN' && v.kind !== 'AEXPR_NOT_BETWEEN' && v.kind !== 'AEXPR_BETWEEN_SYM' && v.kind !== 'AEXPR_NOT_BETWEEN_SYM' && v.kind !== 'AEXPR_NULLIF' && v.kind !== 'AEXPR_DISTINCT' && v.kind !== 'AEXPR_NOT_DISTINCT') {
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
    case 'A_Indirection':
      so(v, ['arg', 'indirection'], onde);
      expressao(v.arg, ctx, onde);
      for (const i of v.indirection ?? []) {
        const [it, iv] = tipoDe(i);
        if (it === 'String') continue;
        if (it !== 'A_Indices') recusa(`${onde}: indexação inesperada`);
        so(iv, ['is_slice', 'lidx', 'uidx'], onde);
        if (iv.lidx) expressao(iv.lidx, ctx, onde);
        if (iv.uidx) expressao(iv.uidx, ctx, onde);
      }
      return;
    case 'A_ArrayExpr':
      so(v, ['elements', 'list_start', 'list_end'], onde);
      for (const x of v.elements ?? []) expressao(x, ctx, onde);
      return;
    case 'RowExpr':
      so(v, ['args', 'row_format', 'colnames', 'row_typeid'], onde);
      for (const x of v.args ?? []) expressao(x, ctx, onde);
      return;
    case 'MultiAssignRef':
      so(v, ['source', 'colno', 'ncolumns'], onde);
      expressao(v.source, ctx, onde);
      return;
    case 'SQLValueFunction':
      if (!SVF_OK.has(v.op)) recusa(`${onde}: ${String(v.op).replace('SVFOP_', '')} não é permitido (só CURRENT_DATE, CURRENT_TIMESTAMP e parecidos)`);
      return;
    case 'FuncCall': {
      so(v, ['funcname', 'args', 'agg_order', 'agg_filter', 'over', 'agg_star', 'agg_distinct', 'funcformat'], onde);
      const nome = strings(v.funcname, onde);
      const base = nome.length === 2 && nome[0] === 'pg_catalog' ? nome[1]! : nome.length === 1 ? nome[0]! : '';
      const agregado = AGREGADOS.has(base);
      const ok = FUNCOES.has(base) || (ctx.agregados === true && agregado) || (ctx.consulta === true && nome.length === 1 && perfil.acesso.has(base));
      if (!ok) {
        recusa(
          `${onde}: a função "${nome.join('.')}" não é permitida (só funções nativas simples, sem esquema${ctx.agregados ? ', agregados e de janela' : ''}${ctx.consulta ? ' e as funções de acesso do sistema' : ''}). ` +
            'Função que grava, lê tabelas fechadas ou olha o ambiente é uma porta para o que o item "fechado" protege.',
        );
      }
      if (v.over && !agregado && !FUNCOES.has(base)) recusa(`${onde}: OVER só com agregados`);
      if (base === 'nextval' || base === 'currval' || base === 'setval') nomeDeSequencia(v.args ?? [], onde);
      for (const x of v.args ?? []) expressao(x, ctx, onde);
      if (v.agg_filter) expressao(v.agg_filter, ctx, onde);
      for (const o of v.agg_order ?? []) ordenacao(o, ctx, onde);
      if (v.over) {
        so(v.over, ['partitionClause', 'orderClause', 'frameOptions', 'startOffset', 'endOffset'], onde);
        for (const x of v.over.partitionClause ?? []) expressao(x, ctx, onde);
        for (const o of v.over.orderClause ?? []) ordenacao(o, ctx, onde);
        if (v.over.startOffset) expressao(v.over.startOffset, ctx, onde);
        if (v.over.endOffset) expressao(v.over.endOffset, ctx, onde);
      }
      return;
    }
    case 'SubLink': {
      if (!ctx.consulta) recusa(`${onde}: subconsulta (SELECT dentro da expressão) não cabe aqui`);
      so(v, ['subLinkType', 'testexpr', 'operName', 'subselect', 'subLinkId'], onde);
      if (v.testexpr) expressao(v.testexpr, ctx, onde);
      if (v.operName) {
        const op = strings(v.operName, onde);
        if (op.length !== 1 || !OPERADORES.has(op[0]!)) recusa(`${onde}: o operador "${op.join('.')}" não é permitido`);
      }
      selecionar(v.subselect, ctx, onde);
      return;
    }
    default:
      return recusa(`${onde}: expressão do tipo ${t} não é permitida`);
  }
}

function ordenacao(o: No, ctx: Ctx, onde: string): void {
  const [, sb] = tipoDe(o);
  so(sb, ['node', 'sortby_dir', 'sortby_nulls'], onde);
  expressao(sb.node, ctx, onde);
}

// ------------------------------------------------------------------ consultas (SELECT)

const SELECT_CHAVES = ['targetList', 'fromClause', 'whereClause', 'groupClause', 'havingClause', 'sortClause', 'limitCount', 'limitOffset', 'limitOption', 'op', 'all', 'larg', 'rarg', 'valuesLists', 'withClause', 'distinctClause'];

/** `no` é { SelectStmt: {...} } (ou o corpo direto quando vem de larg/rarg de UNION). */
function selecionar(no: No, ctx: Ctx, onde: string): void {
  const corpo = no && no.SelectStmt ? no.SelectStmt : no;
  selectCorpo(corpo, ctx, onde);
}

function selectCorpo(s: No, ctx: Ctx, onde: string): void {
  if (!s || typeof s !== 'object') recusa(`${onde}: consulta inesperada`);
  if (s.intoClause !== undefined) recusa(`${onde}: SELECT … INTO não é permitido: use CREATE TABLE … AS`);
  if (s.lockingClause !== undefined) recusa(`${onde}: FOR UPDATE/SHARE não é permitido por aqui`);
  if (s.windowClause !== undefined) recusa(`${onde}: WINDOW nomeada não é permitida: escreva o OVER (…) na própria função`);
  so(s, SELECT_CHAVES, onde);
  const c: Ctx = { ...CONSULTA, params: ctx.params };
  if (s.withClause) {
    so(s.withClause, ['ctes', 'recursive'], `${onde} (WITH)`);
    for (const cte of s.withClause.ctes ?? []) {
      const [ct, cv] = tipoDe(cte);
      if (ct !== 'CommonTableExpr') recusa(`${onde}: WITH inesperado`);
      so(cv, ['ctename', 'aliascolnames', 'ctematerialized', 'ctequery'], `${onde} (WITH)`);
      const [qt] = tipoDe(cv.ctequery);
      if (qt !== 'SelectStmt') recusa(`${onde}: dentro do WITH só SELECT (INSERT/UPDATE/DELETE dentro de WITH foi o furo do CREATE TABLE AS; escreva o comando de dados à parte)`);
      selecionar(cv.ctequery, c, onde);
    }
  }
  if (s.op !== undefined && s.op !== 'SETOP_NONE') {
    selecionar(s.larg, c, onde);
    selecionar(s.rarg, c, onde);
  }
  for (const r of s.targetList ?? []) {
    const [, rt] = tipoDe(r);
    so(rt, ['name', 'val', 'indirection'], onde);
    if (rt.indirection) recusa(`${onde}: indireção no alvo inesperada`);
    if (rt.val) expressao(rt.val, c, onde);
  }
  for (const d of s.distinctClause ?? []) if (d && Object.keys(d).length) expressao(d, c, onde);
  for (const f of s.fromClause ?? []) origem(f, c, onde);
  for (const k of ['whereClause', 'havingClause', 'limitCount', 'limitOffset'] as const) if (s[k]) expressao(s[k], c, onde);
  for (const g of s.groupClause ?? []) expressao(g, c, onde);
  for (const o of s.sortClause ?? []) ordenacao(o, c, onde);
  for (const lista of s.valuesLists ?? []) {
    const [, lv] = tipoDe(lista);
    for (const x of lv.items ?? []) expressao(x, c, onde);
  }
}

/** Item do FROM: tabela, JOIN, subconsulta ou função que devolve linhas. */
function origem(n: No, ctx: Ctx, onde: string): void {
  const [ot, ov] = tipoDe(n);
  if (ot === 'RangeVar') {
    relacao(ov, onde, 'ler');
  } else if (ot === 'JoinExpr') {
    so(ov, ['jointype', 'isNatural', 'larg', 'rarg', 'usingClause', 'quals', 'alias', 'join_using_alias'], `${onde} (JOIN)`);
    origem(ov.larg, ctx, onde);
    origem(ov.rarg, ctx, onde);
    if (ov.quals) expressao(ov.quals, ctx, onde);
  } else if (ot === 'RangeSubselect') {
    so(ov, ['lateral', 'subquery', 'alias'], onde);
    selecionar(ov.subquery, ctx, onde);
  } else if (ot === 'RangeFunction') {
    so(ov, ['lateral', 'ordinality', 'is_rowsfrom', 'functions', 'alias', 'coldeflist'], onde);
    if (ov.coldeflist) recusa(`${onde}: lista de colunas da função não é permitida`);
    for (const f of ov.functions ?? []) {
      const [, fl] = tipoDe(f);
      const [ft, fv] = tipoDe(fl.items[0]);
      const nome = ft === 'FuncCall' ? strings(fv.funcname, onde) : [];
      if (ft !== 'FuncCall' || nome.length !== 1 || !FUNCOES_DE_TABELA.has(nome[0]!)) {
        recusa(`${onde}: no FROM só estas funções: ${[...FUNCOES_DE_TABELA].join(', ')}`);
      }
      so(fv, ['funcname', 'args', 'funcformat'], onde);
      for (const x of fv.args ?? []) expressao(x, ctx, onde);
    }
  } else recusa(`${onde}: ${ot} não é permitido no FROM (só tabelas, JOIN, subconsultas e ${[...FUNCOES_DE_TABELA].slice(0, 3).join('/')}…)`);
}

// ------------------------------------------------------------------ constante verdadeira (WHERE que pega tudo)

/** true/false se a expressão é uma constante booleana provada; undefined se depende de dados. */
function avaliar(no: No): boolean | undefined {
  if (!no || typeof no !== 'object') return undefined;
  const [t, v] = tipoDe(no);
  if (t === 'A_Const') return v.boolval ? v.boolval.boolval === true : undefined;
  if (t === 'TypeCast') return avaliar(v.arg);
  if (t === 'BooleanTest') return undefined;
  if (t === 'BoolExpr') {
    const args = (v.args ?? []).map(avaliar);
    if (v.boolop === 'AND_EXPR') return args.some((a: boolean | undefined) => a === false) ? false : args.every((a: boolean | undefined) => a === true) ? true : undefined;
    if (v.boolop === 'OR_EXPR') return args.some((a: boolean | undefined) => a === true) ? true : args.every((a: boolean | undefined) => a === false) ? false : undefined;
    if (v.boolop === 'NOT_EXPR') return args[0] === undefined ? undefined : !args[0];
    return undefined;
  }
  if (t === 'A_Expr' && v.kind === 'AEXPR_OP' && v.lexpr && v.rexpr) {
    const op = v.name?.[0]?.String?.sval;
    const [lt, lv] = tipoDe(v.lexpr);
    const [rt, rv] = tipoDe(v.rexpr);
    if (lt === 'ColumnRef' && rt === 'ColumnRef') {
      // coluna comparada com ela mesma: a = a
      const mesma = JSON.stringify(semLocation(lv)) === JSON.stringify(semLocation(rv));
      if (mesma && (op === '=' || op === '<=' || op === '>=')) return true;
      if (mesma && (op === '<>' || op === '<' || op === '>')) return false;
      return undefined;
    }
    const valor = (c: No): string | number | undefined => (c.ival !== undefined ? c.ival.ival ?? 0 : c.fval !== undefined ? Number(c.fval.fval) : c.sval !== undefined ? c.sval.sval : undefined);
    if (lt === 'A_Const' && rt === 'A_Const') {
      const a = valor(lv);
      const b = valor(rv);
      if (a === undefined || b === undefined || typeof a !== typeof b) return undefined;
      switch (op) {
        case '=': return a === b;
        case '<>': case '!=': return a !== b;
        case '<': return a < b;
        case '>': return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
      }
    }
  }
  return undefined;
}

/** WHERE que pega a tabela inteira? (sem WHERE, constante verdadeira ou coluna = ela mesma) */
const pegaTudo = (where: No): boolean => !where || avaliar(where) === true;

// ------------------------------------------------------------------ comandos

interface Achado {
  tipo: string;
  acao: Acao;
  o_que: string;
  avisos?: string[];
  /** muda estrutura (snapshot do esquema antes) */
  estrutura?: boolean;
  dados?: boolean;
  copiar?: string[];
  criou?: string;
  matview?: string;
  funcao?: string;
  ligouRls?: string;
  renomeia?: boolean;
  alvo?: { tabela: string; op: 'update' | 'delete' };
}

const direto = (tipo: string, o_que: string, extra: Partial<Achado> = {}): Achado => ({ tipo, acao: 'direto', o_que, estrutura: true, ...extra });
const confirmar = (tipo: string, o_que: string, extra: Partial<Achado> = {}): Achado => ({ tipo, acao: 'confirmar', o_que, estrutura: true, ...extra });

function constraint(c: No, onde: string, ctxCheck: Ctx = { colunas: true }): { padrao?: boolean } {
  so(c, ['contype', 'conname', 'deferrable', 'initdeferred', 'is_enforced', 'initially_valid', 'skip_validation', 'raw_expr', 'generated_when', 'generated_kind', 'keys', 'including', 'nulls_not_distinct', 'pktable', 'fk_attrs', 'pk_attrs', 'fk_matchtype', 'fk_upd_action', 'fk_del_action', 'fk_del_set_cols', 'options', 'indexname', 'indexspace', 'access_method', 'where_clause', 'exclusions', 'old_pktable_oid', 'inhcount', 'is_no_inherit', 'cooked_expr'], `${onde} (restrição)`);
  if (c.conname !== undefined) nomeNovo(c.conname, 'da restrição', onde);
  if (c.options !== undefined || c.indexname !== undefined || c.indexspace !== undefined || c.access_method !== undefined || c.where_clause !== undefined || c.exclusions !== undefined) {
    recusa(`${onde}: opções de armazenamento ou EXCLUDE em restrição não são permitidas`);
  }
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
      expressao(c.raw_expr, ctxCheck, `${onde} (CHECK)`);
      return {};
    case 'CONSTR_PRIMARY':
    case 'CONSTR_UNIQUE':
      strings(c.keys, onde);
      strings(c.including, onde);
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
  nomeNovo(cd.colname, 'da coluna', onde);
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
  const t = relacao(s.relation, 'CREATE TABLE', 'estrutura');
  nomeNovo(t, 'da tabela', 'CREATE TABLE');
  if (!Array.isArray(s.tableElts) || !s.tableElts.length) recusa(`CREATE TABLE só na forma "CREATE TABLE ${t} ( coluna tipo, … )", com ao menos uma coluna`);
  const avisos: string[] = [];
  for (const el of s.tableElts) {
    const [et, ev] = tipoDe(el);
    if (et === 'ColumnDef') avisos.push(...colunaDef(ev, `CREATE TABLE ${t}`).avisos);
    else if (et === 'Constraint') constraint(ev, `CREATE TABLE ${t}`);
    else if (et === 'TableLikeClause') {
      so(ev, ['relation', 'options'], 'CREATE TABLE (LIKE)');
      relacao(ev.relation, 'CREATE TABLE (LIKE)');
    } else recusa(`CREATE TABLE ${t}: elemento ${et} não é permitido`);
  }
  return [direto('CREATE TABLE', `Cria a tabela ${t}${s.if_not_exists ? ' (se ainda não existir)' : ''}`, { criou: s.if_not_exists ? undefined : t, avisos })];
}

function criarTabelaComo(s: No): Achado[] {
  so(s, ['query', 'into', 'objtype', 'is_select_into', 'if_not_exists'], 'CREATE TABLE AS');
  if (s.objtype !== 'OBJECT_TABLE' && s.objtype !== 'OBJECT_MATVIEW') recusa('CREATE … AS: só tabela ou view materializada');
  if (s.is_select_into) recusa('SELECT … INTO não é permitido: use CREATE TABLE … AS');
  const into = s.into;
  so(into, ['rel', 'colNames', 'accessMethod', 'options', 'onCommit', 'tableSpaceName', 'viewQuery', 'skipData'], 'CREATE TABLE AS');
  if (into.accessMethod !== undefined || into.options !== undefined || into.tableSpaceName !== undefined) recusa('CREATE TABLE AS: método de acesso, opções e tablespace não são permitidos');
  if (into.onCommit !== undefined && into.onCommit !== 'ONCOMMIT_NOOP') recusa('CREATE TABLE AS: ON COMMIT não é permitido');
  const t = relacao(into.rel, 'CREATE TABLE AS', 'estrutura');
  nomeNovo(t, 'da tabela', 'CREATE TABLE AS');
  for (const c of strings(into.colNames, 'CREATE TABLE AS')) nomeNovo(c, 'da coluna', 'CREATE TABLE AS');
  const [qt] = tipoDe(s.query);
  if (qt !== 'SelectStmt') recusa('CREATE TABLE AS: o comando de dados (EXECUTE, INSERT…) não é permitido; use um SELECT');
  selecionar(s.query, CONSULTA, 'CREATE TABLE AS (a consulta)');
  if (s.objtype === 'OBJECT_MATVIEW') {
    return [direto('CREATE MATERIALIZED VIEW', `Cria a view materializada ${t} (guarda uma cópia do resultado; só quem recebe GRANT enxerga)`, { matview: s.if_not_exists ? undefined : t, avisos: [`a view materializada ${t} não tem segurança por linha: o servidor tira o acesso de usuários logados; dê GRANT só a quem deve ver tudo`] })];
  }
  return [direto('CREATE TABLE AS', `Cria a tabela ${t} a partir de uma consulta (copia os dados dela)`, { criou: s.if_not_exists ? undefined : t })];
}

function atualizarVisao(s: No): Achado[] {
  so(s, ['relation', 'skipData', 'concurrent'], 'REFRESH MATERIALIZED VIEW');
  if (s.concurrent || s.skipData) recusa('REFRESH MATERIALIZED VIEW: CONCURRENTLY e WITH NO DATA não são permitidos');
  const t = relacao(s.relation, 'REFRESH MATERIALIZED VIEW', 'ler');
  return [{ tipo: 'REFRESH MATERIALIZED VIEW', acao: 'direto', o_que: `Recalcula a view materializada ${t}`, dados: true }];
}

function alterarTabela(s: No): Achado[] {
  so(s, ['relation', 'cmds', 'objtype', 'missing_ok'], 'ALTER TABLE');
  if (s.objtype !== 'OBJECT_TABLE') recusa('ALTER só em tabela (não em view, índice ou sequência)');
  const t = relacao(s.relation, 'ALTER TABLE', 'estrutura');
  return (s.cmds ?? []).map((cmd: No): Achado => {
    const [ct, c] = tipoDe(cmd);
    if (ct !== 'AlterTableCmd') recusa('ALTER TABLE: comando inesperado');
    so(c, ['subtype', 'name', 'def', 'behavior', 'missing_ok'], 'ALTER TABLE');
    const onde = `ALTER TABLE ${t}`;
    const copiar = { copiar: [t] };
    if (c.behavior !== undefined && c.behavior !== 'DROP_RESTRICT') recusa('ALTER TABLE: CASCADE não é permitido');
    switch (c.subtype) {
      case 'AT_AddColumn': {
        const [, cd] = tipoDe(c.def);
        const r = colunaDef(cd, onde);
        return direto('ALTER TABLE ADD COLUMN', `Acrescenta a coluna ${r.nome} na tabela ${t}${c.missing_ok ? ' (se ainda não existir)' : ''}`, { avisos: r.avisos, ...copiar });
      }
      case 'AT_AddConstraint': {
        const [, k] = tipoDe(c.def);
        if (!['CONSTR_CHECK', 'CONSTR_PRIMARY', 'CONSTR_UNIQUE', 'CONSTR_FOREIGN'].includes(k.contype)) recusa(`${onde}: só CHECK, PRIMARY KEY, UNIQUE e FOREIGN KEY`);
        constraint(k, onde);
        const quais: Record<string, string> = { CONSTR_CHECK: 'check', CONSTR_PRIMARY: 'primary key', CONSTR_UNIQUE: 'unique', CONSTR_FOREIGN: 'foreign key' };
        return direto('ALTER TABLE ADD CONSTRAINT', `Acrescenta uma restrição${k.conname ? ` "${k.conname}"` : ''} (${quais[k.contype]}) na tabela ${t}`, copiar);
      }
      case 'AT_ColumnDefault':
        if (c.def) expressao(c.def, { colunas: false }, `${onde} (DEFAULT)`);
        return direto('ALTER COLUMN SET DEFAULT', c.def ? `Muda o valor padrão da coluna ${c.name} da tabela ${t} (só vale para linhas novas)` : `Tira o valor padrão da coluna ${c.name} da tabela ${t}`, copiar);
      case 'AT_SetNotNull':
        return direto('ALTER COLUMN SET NOT NULL', `Torna a coluna ${c.name} da tabela ${t} obrigatória`, { avisos: [`SET NOT NULL falha se já houver linha com ${c.name} vazio`], ...copiar });
      case 'AT_DropNotNull':
        return direto('ALTER COLUMN DROP NOT NULL', `Deixa a coluna ${c.name} da tabela ${t} opcional`, copiar);
      case 'AT_AlterColumnType': {
        const [, cd] = tipoDe(c.def);
        so(cd, ['typeName', 'raw_default', 'colname'], `${onde} (tipo)`);
        tipoPermitido(cd.typeName, `${onde} (tipo)`);
        if (cd.raw_default !== undefined) expressao(cd.raw_default, { colunas: true }, `${onde} (USING)`);
        return direto('ALTER COLUMN TYPE', `Muda o TIPO da coluna ${c.name} da tabela ${t}${cd.raw_default ? ' (com USING: reescreve os valores)' : ''}`, {
          avisos: [`mudar o tipo de ${t}.${c.name} pode FALHAR se os dados que já existem não couberem no tipo novo (e reescreve a tabela inteira); se falhar nada muda`],
          ...copiar,
        });
      }
      case 'AT_EnableRowSecurity':
        return direto('ALTER TABLE ENABLE RLS', `Liga a segurança por linha (RLS) na tabela ${t}`, { ligouRls: t });
      case 'AT_ForceRowSecurity':
        return direto('ALTER TABLE FORCE RLS', `Faz a RLS valer também para o dono da tabela ${t}`);
      case 'AT_DisableRowSecurity':
      case 'AT_NoForceRowSecurity':
        return confirmar('ALTER TABLE DISABLE RLS', `DESLIGA a segurança por linha (RLS) da tabela ${t}: ela é o que decide quem vê cada linha`, { avisos: [`sem RLS, todo usuário logado com GRANT em ${t} lê e grava todas as linhas`], ...copiar });
      case 'AT_DropColumn':
        return confirmar('ALTER TABLE DROP COLUMN', `APAGA a coluna ${c.name} da tabela ${t} e os dados dela`, { ...copiar });
      case 'AT_DropConstraint':
        return confirmar('ALTER TABLE DROP CONSTRAINT', `Remove a restrição ${c.name} da tabela ${t}`, copiar);
      default:
        return recusa(`${onde}: a ação ${String(c.subtype).replace('AT_', '')} não é permitida. ${ACEITO}`);
    }
  });
}

function criarIndice(s: No): Achado[] {
  if (s.concurrent) recusa('CREATE INDEX CONCURRENTLY não funciona aqui (o servidor roda dentro de uma transação): use CREATE INDEX');
  so(s, ['idxname', 'relation', 'accessMethod', 'indexParams', 'indexIncludingParams', 'whereClause', 'unique', 'if_not_exists', 'nulls_not_distinct', 'primary', 'isconstraint'], 'CREATE INDEX');
  if (s.primary || s.isconstraint) recusa('CREATE INDEX: use ALTER TABLE … ADD PRIMARY KEY / UNIQUE');
  const t = relacao(s.relation, 'CREATE INDEX', 'estrutura');
  if (s.idxname !== undefined) nomeNovo(s.idxname, 'do índice', 'CREATE INDEX');
  if (s.accessMethod !== undefined && !METODOS_DE_INDICE.has(s.accessMethod)) recusa(`CREATE INDEX: método ${s.accessMethod} não permitido`);
  for (const p of [...(s.indexParams ?? []), ...(s.indexIncludingParams ?? [])]) {
    const [, ip] = tipoDe(p);
    so(ip, ['name', 'expr', 'ordering', 'nulls_ordering', 'opclass', 'opclassopts', 'collation'], 'CREATE INDEX');
    if (ip.opclassopts || ip.collation) recusa('CREATE INDEX: opções de coluna não são permitidas');
    for (const oc of strings(ip.opclass, 'CREATE INDEX')) if (!/^[a-z_]+_ops$/.test(oc)) recusa(`CREATE INDEX: a classe de operador ${oc} não é permitida`);
    if (ip.expr) expressao(ip.expr, { colunas: true }, 'CREATE INDEX (expressão)');
  }
  if (s.whereClause) expressao(s.whereClause, { colunas: true }, 'CREATE INDEX (WHERE)');
  return [direto('CREATE INDEX', `Cria o índice${s.unique ? ' ÚNICO' : ''}${s.idxname ? ` ${s.idxname}` : ''} na tabela ${t}`, { copiar: s.unique ? [t] : undefined })];
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
  const v = relacao(s.view, 'CREATE VIEW', 'estrutura');
  nomeNovo(v, 'da view', 'CREATE VIEW');
  for (const a of strings(s.aliases, 'CREATE VIEW')) nomeNovo(a, 'da coluna', 'CREATE VIEW');
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
  selecionar(s.query, CONSULTA, 'a consulta da view');
  return [direto('CREATE VIEW', `${s.replace ? 'Cria ou SUBSTITUI' : 'Cria'} a view ${v} (com as permissões de quem consulta)`)];
}

function papeis(lista: No, onde: string, obrigatorio: boolean, permitidos: Set<string>): string[] {
  if (!lista) {
    if (obrigatorio) recusa(`${onde} precisa dizer para quem vale: acrescente "TO authenticated" (usuários logados) — sem isso valeria também para quem não fez login`);
    return [];
  }
  return lista.map((r: No) => {
    const [, rv] = tipoDe(r);
    so(rv, ['roletype', 'rolename'], onde);
    if (rv.roletype === 'ROLESPEC_PUBLIC') recusa(`${onde} precisa dizer para quem vale: use "TO authenticated" (usuários logados) — com PUBLIC valeria também para quem não fez login`);
    if (rv.roletype !== 'ROLESPEC_CSTRING' || !permitidos.has(rv.rolename)) recusa(`${onde}: use só ${[...permitidos].map((p) => `"${p}"`).join(', ')} (recebi ${rv.rolename ?? String(rv.roletype).replace('ROLESPEC_', '')}); acesso sem login e papéis internos do banco ficam de fora`);
    return rv.rolename as string;
  });
}

function permissiva(no: No): boolean {
  return !!no && avaliar(no) === true;
}

function politica(tipoStmt: string, s: No): Achado[] {
  so(s, ['policy_name', 'table', 'cmd_name', 'permissive', 'roles', 'qual', 'with_check'], 'POLICY');
  const t = relacao(s.table, 'POLICY', 'estrutura');
  nomeNovo(s.policy_name, 'da política', 'POLICY');
  papeis(s.roles, `a política ${s.policy_name}`, tipoStmt === 'CreatePolicyStmt', PAPEIS_DE_POLITICA);
  const ctx: Ctx = { ...CONSULTA, agregados: false };
  if (s.qual) expressao(s.qual, ctx, `a política ${s.policy_name} (USING)`);
  if (s.with_check) expressao(s.with_check, ctx, `a política ${s.policy_name} (WITH CHECK)`);
  const avisos = permissiva(s.qual) || permissiva(s.with_check) ? [`a política ${s.policy_name} é permissiva (true, 1=1…): libera TODAS as linhas de ${t} para todo usuário logado`] : [];
  const criar = tipoStmt === 'CreatePolicyStmt';
  return [direto(`${criar ? 'CREATE' : 'ALTER'} POLICY`, `${criar ? 'Cria' : 'Altera'} a política ${s.policy_name} da tabela ${t} (regra de quem vê/grava cada linha)`, { avisos })];
}

const OBJETOS_DE_COMENTARIO: Record<string, { quem: string; max: number }> = {
  OBJECT_TABLE: { quem: 'da tabela', max: 1 },
  OBJECT_INDEX: { quem: 'do índice', max: 1 },
  OBJECT_VIEW: { quem: 'da view', max: 1 },
  OBJECT_MATVIEW: { quem: 'da view materializada', max: 1 },
  OBJECT_SEQUENCE: { quem: 'da sequência', max: 1 },
  OBJECT_COLUMN: { quem: 'da coluna', max: 2 },
  OBJECT_POLICY: { quem: 'da política', max: 2 },
  OBJECT_TRIGGER: { quem: 'do gatilho', max: 2 },
  OBJECT_TABCONSTRAINT: { quem: 'da restrição', max: 2 },
  OBJECT_FUNCTION: { quem: 'da função', max: 1 },
  OBJECT_TYPE: { quem: 'do tipo', max: 1 },
};

function comentario(s: No): Achado[] {
  so(s, ['objtype', 'object', 'comment'], 'COMMENT');
  const o = OBJETOS_DE_COMENTARIO[s.objtype];
  if (!o) recusa('COMMENT só em tabela, coluna, índice, view, sequência, política, gatilho, restrição, função e tipo');
  const [ot, ov] = tipoDe(s.object);
  const nomes = ot === 'ObjectWithArgs' ? strings(ov.objname, 'COMMENT') : strings(ov.items, 'COMMENT');
  const sem = nomesSemEsquema(nomes, o.max, 'COMMENT');
  if (['OBJECT_TABLE', 'OBJECT_COLUMN', 'OBJECT_POLICY', 'OBJECT_TRIGGER', 'OBJECT_TABCONSTRAINT'].includes(s.objtype)) semFechadaEstrutura(sem[0]!, 'COMMENT');
  return [direto('COMMENT', `Escreve o comentário ${o.quem} ${nomes.join('.')}`)];
}

const PRIV_TABELA = new Set(['select', 'insert', 'update', 'delete']);
const PRIV_SEQ = new Set(['usage', 'select']);

function conceder(s: No): Achado[] {
  so(s, ['is_grant', 'targtype', 'objtype', 'objects', 'privileges', 'grantees', 'grant_option', 'grantor', 'behavior'], 'GRANT/REVOKE');
  const revoga = s.is_grant !== true;
  const verbo = revoga ? 'REVOKE' : 'GRANT';
  if (s.targtype !== 'ACL_TARGET_OBJECT' || !['OBJECT_TABLE', 'OBJECT_SEQUENCE', 'OBJECT_FUNCTION'].includes(s.objtype)) {
    recusa(`${verbo} só em tabela, sequência ou função do esquema public (sem "ALL TABLES IN SCHEMA", sem esquema, sem banco)`);
  }
  if (s.grant_option || s.grantor) recusa(`${verbo}: WITH GRANT OPTION e GRANTED BY não são permitidos`);
  if (s.behavior !== undefined && s.behavior !== 'DROP_RESTRICT') recusa(`${verbo}: CASCADE não é permitido`);
  if (!s.privileges?.length) recusa(`${verbo} precisa dizer os privilégios: SELECT, INSERT, UPDATE, DELETE (USAGE em sequência, EXECUTE em função); "ALL" não é permitido (inclui TRUNCATE)`);
  // função: só TIRAR o EXECUTE (confirmação). Dar não precisa: a função nova já sai executável por authenticated e service_role, e dar EXECUTE de uma função
  // SECURITY DEFINER que o sistema já tinha (e que ficou fechada de propósito) abriria uma porta
  if (!revoga && s.objtype === 'OBJECT_FUNCTION') recusa('GRANT EXECUTE não é necessário nem permitido: a função criada por aqui já sai executável por authenticated e service_role; função do sistema que está fechada fica fechada');
  const permitidos = s.objtype === 'OBJECT_TABLE' ? PRIV_TABELA : s.objtype === 'OBJECT_SEQUENCE' ? PRIV_SEQ : new Set(['execute']);
  const privs: string[] = s.privileges.map((p: No) => {
    const [, pv] = tipoDe(p);
    so(pv, ['priv_name', 'cols'], verbo);
    strings(pv.cols, verbo);
    if (!permitidos.has(pv.priv_name)) recusa(`${verbo}: o privilégio ${String(pv.priv_name).toUpperCase()} não é permitido aqui (só ${[...permitidos].map((x) => x.toUpperCase()).join(', ')})`);
    return String(pv.priv_name).toUpperCase();
  });
  const nomes: string[] = (s.objects ?? []).map((o: No) => {
    if (s.objtype === 'OBJECT_FUNCTION') {
      const [ft, fv] = tipoDe(o);
      if (ft !== 'ObjectWithArgs') recusa(`${verbo}: função esperada`);
      const n = nomesSemEsquema(strings(fv.objname, verbo), 1, verbo);
      semFechadaEstrutura(n[0]!, verbo);
      return n[0]!;
    }
    return relacao(o, verbo, 'estrutura');
  });
  // quem recebe: papéis da aplicação. REVOKE também pode tirar de anon/PUBLIC (tirar acesso nunca abre nada)
  const alvos = revoga ? new Set([...PAPEIS, 'anon']) : PAPEIS;
  if (revoga) {
    for (const g of s.grantees ?? []) {
      const [, gv] = tipoDe(g);
      if (gv.roletype === 'ROLESPEC_PUBLIC') continue;
      papeis([g], verbo, true, alvos);
    }
  }
  const para: string[] = revoga ? (s.grantees ?? []).map((g: No) => (tipoDe(g)[1].roletype === 'ROLESPEC_PUBLIC' ? 'PUBLIC' : tipoDe(g)[1].rolename)) : papeis(s.grantees, verbo, true, PAPEIS);
  if (!revoga && s.objtype === 'OBJECT_TABLE' && para.includes('mcp_leitor') && privs.some((p) => p !== 'SELECT')) recusa('GRANT para mcp_leitor: o leitor do conector só recebe SELECT');
  const o_que = `${revoga ? 'TIRA' : 'Dá'} ${privs.join(', ')} em ${nomes.join(', ')} ${revoga ? 'de' : 'a'} ${para.join(', ')}`;
  if (revoga) return [confirmar('REVOKE', o_que, { avisos: [`tirar acesso pode derrubar telas que dependem dele`] })];
  return [direto('GRANT', o_que, { avisos: para.includes('authenticated') ? [`GRANT em ${nomes.join(', ')} vale para TODOS os usuários logados (authenticated); quem vê cada linha é decidido pela RLS`] : [] })];
}

// ------------------------------------------------------------------ renomear, sequência, tipos, apagar

const RENOMEAVEIS = new Set(['OBJECT_TABLE', 'OBJECT_COLUMN', 'OBJECT_INDEX', 'OBJECT_VIEW', 'OBJECT_MATVIEW', 'OBJECT_SEQUENCE', 'OBJECT_TABCONSTRAINT', 'OBJECT_POLICY', 'OBJECT_TRIGGER']);

function renomear(s: No): Achado[] {
  so(s, ['renameType', 'relationType', 'relation', 'object', 'subname', 'newname', 'behavior', 'missing_ok'], 'RENAME');
  if (!RENOMEAVEIS.has(s.renameType)) recusa('renomear só vale para tabela, coluna, índice, view, sequência, restrição, política e gatilho');
  if (s.object !== undefined) recusa('RENAME: forma não permitida');
  const t = relacao(s.relation, 'RENAME', 'estrutura');
  nomeNovo(s.newname, 'novo', 'RENAME');
  if (s.subname !== undefined) semFechadaTotal(String(s.subname), 'RENAME');
  const que = s.renameType.replace('OBJECT_', '').toLowerCase();
  return [
    direto('RENAME', `RENOMEIA ${que} ${s.subname ? `${s.subname} da tabela ` : ''}${t} para ${s.newname}${s.renameType === 'OBJECT_TABLE' ? ' (quem lê o nome antigo quebra)' : ''}`, {
      renomeia: true,
      avisos: [`renomear ${que} ${t} para ${s.newname}: telas, funções e políticas que usam o nome antigo por TEXTO deixam de funcionar`],
    }),
  ];
}

const OPCOES_SEQ = new Set(['start', 'increment', 'minvalue', 'maxvalue', 'cache', 'cycle', 'restart', 'as']);

function opcoesSeq(opts: No, onde: string, criando: boolean): void {
  for (const o of opts ?? []) {
    const [, d] = tipoDe(o);
    so(d, ['defname', 'arg', 'defaction', 'defnamespace'], onde);
    if (d.defnamespace) recusa(`${onde}: opção com namespace não é permitida`);
    if (d.defname === 'owned_by' && criando) {
      const nomes = strings(d.arg?.List?.items, onde);
      if (nomes.length === 1 && nomes[0] === 'none') continue;
      const sem = nomesSemEsquema(nomes, 2, onde);
      if (sem.length !== 2) recusa(`${onde}: OWNED BY tabela.coluna`);
      semFechadaEstrutura(sem[0]!, onde);
      continue;
    }
    if (!OPCOES_SEQ.has(d.defname)) recusa(`${onde}: a opção ${d.defname} não é permitida`);
  }
}

function criarSequencia(s: No): Achado[] {
  so(s, ['sequence', 'options', 'ownerId', 'for_identity', 'if_not_exists'], 'CREATE SEQUENCE');
  if (s.for_identity || s.ownerId) recusa('CREATE SEQUENCE: forma não permitida');
  const q = relacao(s.sequence, 'CREATE SEQUENCE', 'estrutura');
  nomeNovo(q, 'da sequência', 'CREATE SEQUENCE');
  opcoesSeq(s.options, 'CREATE SEQUENCE', true);
  return [direto('CREATE SEQUENCE', `Cria a sequência ${q}`)];
}

function alterarSequencia(s: No): Achado[] {
  so(s, ['sequence', 'options', 'for_identity', 'missing_ok'], 'ALTER SEQUENCE');
  if (s.for_identity) recusa('ALTER SEQUENCE: forma não permitida');
  const q = relacao(s.sequence, 'ALTER SEQUENCE', 'estrutura');
  opcoesSeq(s.options, 'ALTER SEQUENCE', false);
  return [direto('ALTER SEQUENCE', `Altera a sequência ${q}`)];
}

function nomeDeTipo(lista: No, onde: string): string {
  const nomes = nomesSemEsquema(strings(lista, onde), 1, onde);
  return nomes[0]!;
}

function criarEnum(s: No): Achado[] {
  so(s, ['typeName', 'vals'], 'CREATE TYPE');
  const n = nomeDeTipo(s.typeName, 'CREATE TYPE');
  nomeNovo(n, 'do tipo', 'CREATE TYPE');
  const vals = strings(s.vals, 'CREATE TYPE');
  if (vals.length > 100 || vals.some((v) => v.length > 63)) recusa('CREATE TYPE: até 100 valores de até 63 caracteres');
  return [direto('CREATE TYPE', `Cria o tipo ${n} (lista de valores: ${vals.slice(0, 6).join(', ')}${vals.length > 6 ? '…' : ''})`)];
}

function criarComposto(s: No): Achado[] {
  so(s, ['typevar', 'coldeflist'], 'CREATE TYPE');
  const n = relacao(s.typevar, 'CREATE TYPE', 'estrutura');
  nomeNovo(n, 'do tipo', 'CREATE TYPE');
  for (const c of s.coldeflist ?? []) {
    const [, cd] = tipoDe(c);
    so(cd, ['colname', 'typeName', 'is_local'], 'CREATE TYPE');
    nomeNovo(cd.colname, 'da coluna', 'CREATE TYPE');
    tipoPermitido(cd.typeName, 'CREATE TYPE');
  }
  return [direto('CREATE TYPE', `Cria o tipo composto ${n}`)];
}

function alterarEnum(s: No): Achado[] {
  so(s, ['typeName', 'oldVal', 'newVal', 'newValNeighbor', 'newValIsAfter', 'skipIfNewValExists'], 'ALTER TYPE');
  if (s.oldVal !== undefined) recusa('ALTER TYPE: renomear valor não é permitido; só ADD VALUE');
  const n = nomeDeTipo(s.typeName, 'ALTER TYPE');
  return [direto('ALTER TYPE ADD VALUE', `Acrescenta o valor "${String(s.newVal).slice(0, 63)}" ao tipo ${n}`)];
}

const APAGAVEIS = new Set(['OBJECT_TABLE', 'OBJECT_VIEW', 'OBJECT_MATVIEW', 'OBJECT_INDEX', 'OBJECT_SEQUENCE', 'OBJECT_POLICY', 'OBJECT_TRIGGER', 'OBJECT_FUNCTION', 'OBJECT_TYPE']);

function apagar(s: No): Achado[] {
  so(s, ['objects', 'removeType', 'behavior', 'missing_ok', 'concurrent'], 'DROP');
  if (!APAGAVEIS.has(s.removeType)) recusa(`DROP ${String(s.removeType).replace('OBJECT_', '')} não é permitido por aqui (esquema, extensão, papel, banco… são de quem administra o servidor)`);
  if (s.concurrent) recusa('DROP INDEX CONCURRENTLY não funciona aqui (o servidor roda dentro de uma transação)');
  const que = s.removeType.replace('OBJECT_', '').replace('MATVIEW', 'MATERIALIZED VIEW');
  const cascata = s.behavior === 'DROP_CASCADE';
  const nomes: string[] = [];
  const copiar: string[] = [];
  for (const o of s.objects ?? []) {
    const [ot, ov] = tipoDe(o);
    if (s.removeType === 'OBJECT_FUNCTION') {
      if (ot !== 'ObjectWithArgs') recusa('DROP FUNCTION: forma inesperada');
      const n = nomesSemEsquema(strings(ov.objname, 'DROP FUNCTION'), 1, 'DROP FUNCTION');
      semFechadaEstrutura(n[0]!, 'DROP FUNCTION');
      nomes.push(n[0]!);
    } else if (s.removeType === 'OBJECT_TYPE') {
      if (ot !== 'TypeName') recusa('DROP TYPE: forma inesperada');
      nomes.push(nomeDeTipo(ov.names, 'DROP TYPE'));
    } else {
      if (ot !== 'List') recusa('DROP: forma inesperada');
      const itens = strings(ov.items, 'DROP');
      if (s.removeType === 'OBJECT_POLICY' || s.removeType === 'OBJECT_TRIGGER') {
        const sem = nomesSemEsquema(itens, 2, `DROP ${que}`);
        if (sem.length !== 2) recusa(`DROP ${que}: use DROP ${que} nome ON tabela`);
        semFechadaEstrutura(sem[0]!, `DROP ${que}`);
        nomes.push(`${sem[1]} (em ${sem[0]})`);
        copiar.push(sem[0]!);
      } else {
        const sem = nomesSemEsquema(itens, 1, `DROP ${que}`);
        semFechadaEstrutura(sem[0]!, `DROP ${que}`);
        nomes.push(sem[0]!);
        if (s.removeType === 'OBJECT_TABLE') copiar.push(sem[0]!);
      }
    }
  }
  if (!nomes.length) recusa('DROP sem nome');
  return [
    confirmar(`DROP ${que}`, `APAGA ${que} ${nomes.join(', ')}${cascata ? ' com CASCADE (leva junto tudo que depende)' : ''}`, {
      copiar,
      avisos: s.removeType === 'OBJECT_TABLE' ? [`DROP TABLE apaga as linhas: o servidor guarda uma cópia (snapshot) antes, mas só dura 60 dias`] : [],
    }),
  ];
}

function esvaziar(s: No): Achado[] {
  so(s, ['relations', 'restart_seqs', 'behavior'], 'TRUNCATE');
  if (s.behavior === 'DROP_CASCADE') recusa('TRUNCATE … CASCADE não é permitido (esvazia também as tabelas que apontam para estas)');
  const ts: string[] = (s.relations ?? []).map((r: No) => relacao(r, 'TRUNCATE', 'estrutura'));
  return [confirmar('TRUNCATE', `ESVAZIA a(s) tabela(s) ${ts.join(', ')} (apaga TODAS as linhas)`, { copiar: ts, dados: true, estrutura: false })];
}

// ------------------------------------------------------------------ dados (INSERT, UPDATE, DELETE)

function alvoDeEscrita(r: No, onde: string): string {
  so(r, ['catalogname', 'schemaname', 'relname', 'inh', 'relpersistence', 'alias'], onde);
  if (r.alias) so(r.alias, ['aliasname', 'colnames'], onde);
  return relacao(r, onde, 'escrever');
}

function comWith(w: No, onde: string): void {
  if (!w) return;
  so(w, ['ctes', 'recursive'], `${onde} (WITH)`);
  for (const cte of w.ctes ?? []) {
    const [ct, cv] = tipoDe(cte);
    if (ct !== 'CommonTableExpr') recusa(`${onde}: WITH inesperado`);
    so(cv, ['ctename', 'aliascolnames', 'ctematerialized', 'ctequery'], `${onde} (WITH)`);
    const [qt] = tipoDe(cv.ctequery);
    if (qt !== 'SelectStmt') recusa(`${onde}: dentro do WITH só SELECT; escreva o INSERT/UPDATE/DELETE como comando à parte`);
    selecionar(cv.ctequery, CONSULTA, onde);
  }
}

function retornando(r: No, onde: string): void {
  if (!r) return;
  so(r, ['exprs', 'options'], `${onde} (RETURNING)`);
  if (r.options) recusa(`${onde}: RETURNING OLD/NEW não é permitido`);
  for (const e of r.exprs ?? []) {
    const [, rt] = tipoDe(e);
    so(rt, ['name', 'val'], onde);
    expressao(rt.val, CONSULTA, `${onde} (RETURNING)`);
  }
}

function atribuicoes(lista: No, onde: string): void {
  for (const r of lista ?? []) {
    const [, rt] = tipoDe(r);
    so(rt, ['name', 'val', 'indirection'], onde);
    if (rt.indirection) recusa(`${onde}: atribuição a parte de coluna (a.b, a[1]) não é permitida: escreva a coluna inteira`);
    if (rt.name) semFechadaTotal(rt.name, onde);
    if (rt.val) expressao(rt.val, CONSULTA, onde);
  }
}

function inserir(s: No): Achado[] {
  so(s, ['relation', 'cols', 'selectStmt', 'onConflictClause', 'returningClause', 'withClause', 'override'], 'INSERT');
  const t = alvoDeEscrita(s.relation, 'INSERT');
  comWith(s.withClause, 'INSERT');
  for (const c of s.cols ?? []) {
    const [, ct] = tipoDe(c);
    so(ct, ['name', 'indirection'], 'INSERT');
    if (ct.indirection) recusa('INSERT: coluna com índice/campo não é permitida');
  }
  if (s.selectStmt) selecionar(s.selectStmt, CONSULTA, 'INSERT');
  let copiar: string[] | undefined;
  if (s.onConflictClause) {
    const oc = s.onConflictClause;
    so(oc, ['action', 'infer', 'targetList', 'whereClause'], 'INSERT … ON CONFLICT');
    if (oc.infer) {
      so(oc.infer, ['indexElems', 'whereClause', 'conname'], 'INSERT … ON CONFLICT');
      for (const ie of oc.infer.indexElems ?? []) {
        const [, iv] = tipoDe(ie);
        so(iv, ['name', 'expr', 'ordering', 'nulls_ordering', 'opclass', 'collation'], 'INSERT … ON CONFLICT');
        if (iv.expr) expressao(iv.expr, CONSULTA, 'INSERT … ON CONFLICT');
      }
      if (oc.infer.whereClause) expressao(oc.infer.whereClause, CONSULTA, 'INSERT … ON CONFLICT');
    }
    if (oc.action === 'ONCONFLICT_UPDATE') {
      atribuicoes(oc.targetList, 'INSERT … ON CONFLICT');
      if (oc.whereClause) expressao(oc.whereClause, CONSULTA, 'INSERT … ON CONFLICT');
      copiar = [t];
    } else if (oc.action !== 'ONCONFLICT_NOTHING') recusa('INSERT … ON CONFLICT: ação inesperada');
  }
  retornando(s.returningClause, 'INSERT');
  return [{ tipo: 'INSERT', acao: 'direto', o_que: `Insere linha(s) na tabela ${t}${copiar ? ' (ON CONFLICT DO UPDATE muda as que já existem)' : ''}`, dados: true, copiar }];
}

function atualizar(s: No): Achado[] {
  so(s, ['relation', 'targetList', 'whereClause', 'fromClause', 'returningClause', 'withClause'], 'UPDATE');
  const t = alvoDeEscrita(s.relation, 'UPDATE');
  comWith(s.withClause, 'UPDATE');
  atribuicoes(s.targetList, 'UPDATE');
  for (const f of s.fromClause ?? []) origem(f, CONSULTA, 'UPDATE');
  if (s.whereClause) expressao(s.whereClause, CONSULTA, 'UPDATE (WHERE)');
  retornando(s.returningClause, 'UPDATE');
  const tudo = pegaTudo(s.whereClause);
  const base = { tipo: 'UPDATE', dados: true, copiar: [t], alvo: { tabela: t, op: 'update' as const } };
  if (tudo) {
    return [{ ...base, acao: 'confirmar', o_que: `ALTERA TODAS as linhas da tabela ${t} (${s.whereClause ? 'o WHERE é sempre verdadeiro' : 'sem WHERE'})` }];
  }
  return [{ ...base, acao: 'direto', o_que: `Altera linhas da tabela ${t} (com WHERE)` }];
}

function apagarLinhas(s: No): Achado[] {
  so(s, ['relation', 'usingClause', 'whereClause', 'returningClause', 'withClause'], 'DELETE');
  const t = alvoDeEscrita(s.relation, 'DELETE');
  comWith(s.withClause, 'DELETE');
  for (const f of s.usingClause ?? []) origem(f, CONSULTA, 'DELETE');
  if (s.whereClause) expressao(s.whereClause, CONSULTA, 'DELETE (WHERE)');
  retornando(s.returningClause, 'DELETE');
  const base = { tipo: 'DELETE', dados: true, copiar: [t], alvo: { tabela: t, op: 'delete' as const } };
  if (pegaTudo(s.whereClause)) {
    return [{ ...base, acao: 'confirmar', o_que: `APAGA TODAS as linhas da tabela ${t} (${s.whereClause ? 'o WHERE é sempre verdadeiro' : 'sem WHERE'})` }];
  }
  return [{ ...base, acao: 'direto', o_que: `Apaga linhas da tabela ${t} (com WHERE)` }];
}

// ------------------------------------------------------------------ funções e gatilhos

const LINGUAGENS = new Set(['sql', 'plpgsql']);
const TIPOS_DE_RETORNO = ['void', 'trigger', 'record'];
const TIPOS_PLPGSQL = /^(text|integer|int|bigint|smallint|numeric(\(\d+(,\d+)?\))?|boolean|bool|date|timestamptz|timestamp|time|uuid|jsonb|json|record|real|double precision|varchar(\(\d+\))?|character varying(\(\d+\))?)(\[\])?$/i;

/** Dentro do corpo de uma função em SQL, $1, $2… são os parâmetros dela. */
let dentroDeFuncao = false;

/**
 * O corpo de uma função em SQL: um ou mais SELECT, INSERT, UPDATE ou DELETE (as mesmas regras de sempre, com $1 liberado).
 * Devolve true se algum UPDATE/DELETE do corpo pega a tabela inteira (sem WHERE, ou WHERE sempre verdadeiro): a função, quando alguém a chamar,
 * apagaria ou mudaria tudo SEM a confirmação que esse comando exigiria solto — por isso criar uma função assim também pede confirmação.
 */
function corpoSql(texto: string, onde: string): boolean {
  let arvore: No;
  try {
    arvore = parseSync(texto);
  } catch (e) {
    return recusa(`${onde}: o corpo da função não é um SQL válido (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`);
  }
  const stmts = (arvore.stmts ?? []).map((x: No) => x.stmt);
  if (!stmts.length) recusa(`${onde}: o corpo da função está vazio`);
  let destroi = false;
  dentroDeFuncao = true;
  try {
    for (const st of stmts) {
      const [t, s] = tipoDe(st);
      varrer(st, onde);
      if (t === 'SelectStmt') selecionar(st, CONSULTA, onde);
      else if (t === 'InsertStmt') inserir(s);
      else if (t === 'UpdateStmt') destroi = atualizar(s).some((a) => a.acao === 'confirmar') || destroi;
      else if (t === 'DeleteStmt') destroi = apagarLinhas(s).some((a) => a.acao === 'confirmar') || destroi;
      else recusa(`${onde}: o corpo da função só pode ter SELECT, INSERT, UPDATE ou DELETE (recebi ${t})`);
    }
  } finally {
    dentroDeFuncao = false;
  }
  return destroi;
}

/** Corpo em plpgsql: só expressões, SE/CASO/laço, RAISE, RETURN e PERFORM. Nada de SQL dinâmico, nada de comando de dados dentro (para isso, LANGUAGE sql). */
function corpoPlpgsql(texto: string, onde: string): void {
  if (texto.includes('$x$')) recusa(`${onde}: o corpo não pode conter "$x$"`);
  let arvore: No;
  try {
    arvore = parsePlPgSQLSync(`create function pg_temp.f() returns trigger language plpgsql as $x$${texto}$x$`);
  } catch (e) {
    return recusa(`${onde}: o corpo plpgsql não é válido (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`);
  }
  const ctx: Ctx = { ...CONSULTA, params: true };
  const expr = (e: No, modo: 'expr' | 'atribuicao' | 'qualquer') => {
    if (!e) return;
    const [, ev] = tipoDe(e);
    let q = String(ev.query ?? '').trim();
    if (modo === 'atribuicao') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(?::=|=)\s*([\s\S]+)$/.exec(q);
      if (!m) return recusa(`${onde}: atribuição em plpgsql só na forma simples "variavel := expressão" (recebi "${q.slice(0, 60)}")`);
      q = m[2]!;
    }
    let a: No;
    try {
      // PERFORM guarda o texto já como "SELECT …"; as demais expressões vêm sem o SELECT
      a = parseSync(modo === 'qualquer' && /^select\b/i.test(q) ? q : `select ${q}`);
    } catch {
      return recusa(`${onde}: expressão plpgsql não reconhecida: "${q.slice(0, 80)}"`);
    }
    if (a.stmts.length !== 1) recusa(`${onde}: expressão plpgsql inesperada`);
    varrer(a.stmts[0].stmt, onde);
    selecionar(a.stmts[0].stmt, ctx, onde);
  };
  const stmt = (st: No) => {
    const [t, v] = tipoDe(st);
    switch (t) {
      case 'PLpgSQL_stmt_block':
        for (const x of v.body ?? []) stmt(x);
        if (v.exceptions) recusa(`${onde}: EXCEPTION em plpgsql não é permitido por aqui`);
        return;
      case 'PLpgSQL_stmt_assign':
        return expr(v.expr, 'atribuicao');
      case 'PLpgSQL_stmt_if':
        expr(v.cond, 'expr');
        for (const x of v.then_body ?? []) stmt(x);
        for (const x of v.elsif_list ?? []) {
          const [, ev] = tipoDe(x);
          expr(ev.cond, 'expr');
          for (const y of ev.stmts ?? []) stmt(y);
        }
        for (const x of v.else_body ?? []) stmt(x);
        return;
      case 'PLpgSQL_stmt_return':
        if (v.expr) expr(v.expr, 'expr');
        return;
      case 'PLpgSQL_stmt_raise':
        for (const p of v.params ?? []) expr(p, 'expr');
        for (const o of v.options ?? []) {
          const [, ov] = tipoDe(o);
          expr(ov.expr, 'expr');
        }
        return;
      case 'PLpgSQL_stmt_perform':
        return expr(v.expr, 'qualquer');
      case 'PLpgSQL_stmt_assert':
        expr(v.cond, 'expr');
        if (v.message) expr(v.message, 'expr');
        return;
      default:
        return recusa(`${onde}: o comando plpgsql ${t.replace('PLpgSQL_stmt_', '').toUpperCase()} não é permitido por aqui (só atribuição, IF, RETURN, RAISE, PERFORM e ASSERT; para ler ou gravar tabelas use LANGUAGE sql)`);
    }
  };
  const f = arvore.plpgsql_funcs?.[0]?.PLpgSQL_function;
  if (!f) return recusa(`${onde}: o corpo plpgsql não foi entendido`);
  for (const d of f.datums ?? []) {
    const [dt, dv] = tipoDe(d);
    if (dt === 'PLpgSQL_var') {
      const nome = String(dv.refname ?? '');
      if (['tg_name', 'tg_when', 'tg_level', 'tg_op', 'tg_relid', 'tg_relname', 'tg_table_name', 'tg_table_schema', 'tg_nargs', 'tg_argv', 'found'].includes(nome)) continue;
      const tn = String(dv.datatype?.PLpgSQL_type?.typname ?? '');
      if (!TIPOS_PLPGSQL.test(tn)) recusa(`${onde}: o tipo "${tn}" da variável ${nome} não é permitido`);
      if (dv.default_val) expr(dv.default_val, 'expr');
    } else if (dt !== 'PLpgSQL_rec' && dt !== 'PLpgSQL_recfield') recusa(`${onde}: declaração plpgsql ${dt} não é permitida`);
  }
  stmt(f.action);
}

function criarFuncao(s: No): Achado[] {
  so(s, ['replace', 'funcname', 'parameters', 'returnType', 'options', 'sql_body'], 'CREATE FUNCTION');
  if (s.sql_body !== undefined) recusa('CREATE FUNCTION: corpo BEGIN ATOMIC não é permitido; use AS $$ … $$');
  const nome = nomesSemEsquema(strings(s.funcname, 'CREATE FUNCTION'), 1, 'CREATE FUNCTION')[0]!;
  nomeNovo(nome, 'da função', 'CREATE FUNCTION');
  semFechadaEstrutura(nome, 'CREATE FUNCTION');
  if (perfil.acesso.has(nome) || FUNCOES.has(nome) || AGREGADOS.has(nome)) recusa(`CREATE FUNCTION: o nome ${nome} já é de uma função do sistema ou nativa`);
  for (const p of s.parameters ?? []) {
    const [, pv] = tipoDe(p);
    so(pv, ['name', 'argType', 'mode', 'defexpr'], 'CREATE FUNCTION');
    if (pv.mode !== undefined && pv.mode !== 'FUNC_PARAM_DEFAULT' && pv.mode !== 'FUNC_PARAM_IN') recusa('CREATE FUNCTION: parâmetros OUT/INOUT/VARIADIC/TABLE não são permitidos');
    if (pv.name !== undefined) nomeNovo(pv.name, 'do parâmetro', 'CREATE FUNCTION');
    tipoPermitido(pv.argType, 'CREATE FUNCTION (parâmetro)');
    if (pv.defexpr) expressao(pv.defexpr, { colunas: false }, 'CREATE FUNCTION (parâmetro)');
  }
  if (!s.returnType) recusa('CREATE FUNCTION: falta o tipo de retorno (RETURNS)');
  tipoPermitido(s.returnType, 'CREATE FUNCTION (retorno)', TIPOS_DE_RETORNO);
  let linguagem = '';
  let corpo = '';
  for (const o of s.options ?? []) {
    const [, d] = tipoDe(o);
    so(d, ['defname', 'arg', 'defaction', 'defnamespace'], 'CREATE FUNCTION');
    if (d.defnamespace) recusa('CREATE FUNCTION: opção com namespace não é permitida');
    switch (d.defname) {
      case 'language':
        linguagem = String(d.arg?.String?.sval ?? '');
        if (!LINGUAGENS.has(linguagem)) recusa(`CREATE FUNCTION: só LANGUAGE sql ou plpgsql (recebi ${linguagem || 'nenhuma'})`);
        break;
      case 'as': {
        const itens = strings(d.arg?.List?.items, 'CREATE FUNCTION');
        if (itens.length !== 1) recusa('CREATE FUNCTION: o corpo precisa ser um texto só (AS $$ … $$)');
        corpo = itens[0]!;
        break;
      }
      case 'security':
        if (d.arg?.Boolean?.boolval === true) {
          recusa('CREATE FUNCTION: SECURITY DEFINER não é permitido (a função rodaria com os poderes do dono e passaria por cima da segurança por linha e dos itens fechados). Use SECURITY INVOKER (o padrão)');
        }
        break;
      case 'volatility':
      case 'strict':
      case 'cost':
      case 'rows':
        break;
      default:
        recusa(`CREATE FUNCTION: a opção ${d.defname} não é permitida (SET, LEAKPROOF, PARALLEL e WINDOW ficam de fora)`);
    }
  }
  if (!linguagem) recusa('CREATE FUNCTION: falta LANGUAGE (sql ou plpgsql)');
  if (!corpo.trim()) recusa('CREATE FUNCTION: falta o corpo (AS $$ … $$)');
  let destroi = false;
  if (linguagem === 'sql') destroi = corpoSql(corpo, `CREATE FUNCTION ${nome}`);
  else corpoPlpgsql(corpo, `CREATE FUNCTION ${nome}`);
  const o_que = `${s.replace ? 'Cria ou SUBSTITUI' : 'Cria'} a função ${nome} (${linguagem}, SECURITY INVOKER)`;
  const extra = {
    funcao: nome,
    avisos: s.replace ? [`CREATE OR REPLACE troca a definição de ${nome} se ela já existir (o snapshot guarda a anterior); telas e políticas que a usam passam a usar a nova`] : [],
  };
  if (destroi) {
    return [confirmar('CREATE FUNCTION', `${o_que} — o corpo tem UPDATE/DELETE que pega a TABELA INTEIRA (sem WHERE): quem chamar a função muda ou apaga tudo`, extra)];
  }
  return [direto('CREATE FUNCTION', o_que, extra)];
}

function criarGatilho(s: No): Achado[] {
  so(s, ['replace', 'isconstraint', 'trigname', 'relation', 'funcname', 'args', 'row', 'timing', 'events', 'columns', 'whenClause', 'transitionRels', 'deferrable', 'initdeferred', 'constrrel'], 'CREATE TRIGGER');
  if (s.isconstraint || s.transitionRels || s.constrrel || s.deferrable || s.initdeferred) recusa('CREATE TRIGGER: gatilho de restrição e tabelas de transição não são permitidos');
  const t = relacao(s.relation, 'CREATE TRIGGER', 'estrutura');
  nomeNovo(s.trigname, 'do gatilho', 'CREATE TRIGGER');
  const f = nomesSemEsquema(strings(s.funcname, 'CREATE TRIGGER'), 1, 'CREATE TRIGGER')[0]!;
  semFechadaEstrutura(f, 'CREATE TRIGGER');
  for (const a of strings(s.args, 'CREATE TRIGGER')) if (a.length > 100) recusa('CREATE TRIGGER: argumento grande demais');
  if ((s.args ?? []).length > 5) recusa('CREATE TRIGGER: no máximo 5 argumentos');
  strings(s.columns, 'CREATE TRIGGER');
  if (s.whenClause) expressao(s.whenClause, { ...CONSULTA, agregados: false }, 'CREATE TRIGGER (WHEN)');
  return [direto('CREATE TRIGGER', `${s.replace ? 'Cria ou SUBSTITUI' : 'Cria'} o gatilho ${s.trigname} na tabela ${t}, que chama a função ${f}`)];
}

// ------------------------------------------------------------------ entrada

function comando(no: No): Achado[] {
  const [t, s] = tipoDe(no);
  switch (t) {
    case 'CreateStmt': return criarTabela(s);
    case 'CreateTableAsStmt': return criarTabelaComo(s);
    case 'RefreshMatViewStmt': return atualizarVisao(s);
    case 'AlterTableStmt': return alterarTabela(s);
    case 'IndexStmt': return criarIndice(s);
    case 'ViewStmt': return criarView(s);
    case 'CreatePolicyStmt':
    case 'AlterPolicyStmt': return politica(t, s);
    case 'CommentStmt': return comentario(s);
    case 'GrantStmt': return conceder(s);
    case 'RenameStmt': return renomear(s);
    case 'CreateSeqStmt': return criarSequencia(s);
    case 'AlterSeqStmt': return alterarSequencia(s);
    case 'CreateEnumStmt': return criarEnum(s);
    case 'CompositeTypeStmt': return criarComposto(s);
    case 'AlterEnumStmt': return alterarEnum(s);
    case 'DropStmt': return apagar(s);
    case 'TruncateStmt': return esvaziar(s);
    case 'InsertStmt': return inserir(s);
    case 'UpdateStmt': return atualizar(s);
    case 'DeleteStmt': return apagarLinhas(s);
    case 'CreateFunctionStmt': return criarFuncao(s);
    case 'CreateTrigStmt': return criarGatilho(s);
    default:
      return recusa(`${POR_TIPO_DE_COMANDO[t] ?? `o comando ${t} não é permitido por aqui`}. ${ACEITO}`);
  }
}

/** Corta o SQL nos comandos que o parser delimitou (posições em BYTES). */
function recortar(sql: string, stmts: No[]): string[] {
  const buf = Buffer.from(sql, 'utf8');
  return stmts.map((x: No) => {
    const ini = Number(x.stmt_location ?? 0);
    const len = Number(x.stmt_len ?? 0);
    return buf.subarray(ini, len > 0 ? ini + len : buf.length).toString('utf8').trim().replace(/;+\s*$/, '').trim();
  });
}

/**
 * Lê o SQL pelo parser do Postgres e diz, comando a comando, se roda direto, se pede confirmação ou se é recusado.
 * Lança `ErroSql` (mensagem em português, com o que reescrever) quando QUALQUER comando é recusado: o pedido todo cai.
 */
export function classificar(sqlBruto: unknown, sistema: SistemaSql = 'rh'): AnaliseSql {
  const novo = PERFIS[sistema];
  if (!novo) recusa(`sistema desconhecido: ${String(sistema)}`);
  const anterior = perfil;
  perfil = novo;
  try {
    return classificarInterno(sqlBruto);
  } catch (e) {
    // expressão aninhada demais estoura a pilha do JavaScript: dúvida é recusa
    if (e instanceof RangeError) return recusa('o SQL é aninhado demais para ser conferido: simplifique (parênteses e funções dentro de funções)');
    throw e;
  } finally {
    perfil = anterior;
  }
}

function classificarInterno(sqlBruto: unknown): AnaliseSql {
  if (typeof sqlBruto !== 'string' || !sqlBruto.trim()) recusa('sql vazio');
  const sql = sqlBruto.trim();
  if (sql.length > MAX_SQL) recusa(`sql grande demais (máximo ${MAX_SQL} caracteres): mande em partes`);
  let arvore: No;
  try {
    arvore = parseSync(sql);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return recusa(`o SQL não é válido para o Postgres (${m.slice(0, 160)}). Corrija e mande de novo.`);
  }
  const brutos: No[] = arvore.stmts ?? [];
  if (!brutos.length) recusa('sql vazio (só comentário?)');
  if (brutos.length > MAX_COMANDOS) recusa(`comandos demais (${brutos.length}; máximo ${MAX_COMANDOS}): mande em partes`);
  const trechos = recortar(sql, brutos);
  const achados: Achado[] = [];
  const porComando: Achado[][] = [];
  brutos.forEach((b, i) => {
    const st = b.stmt;
    if (!st) recusa('sql vazio');
    // o trecho que vai ser executado, lido de novo, tem de dar EXATAMENTE a mesma árvore (nada de dois comandos num trecho só)
    let de_novo: No;
    try {
      de_novo = parseSync(trechos[i]!);
    } catch {
      return recusa(`o comando ${i + 1} não pôde ser separado com segurança: mande-o sozinho`);
    }
    if ((de_novo.stmts ?? []).length !== 1 || JSON.stringify(semLocation(de_novo.stmts[0].stmt)) !== JSON.stringify(semLocation(st))) {
      recusa(`o comando ${i + 1} não pôde ser separado com segurança: mande-o sozinho`);
    }
    varrer(st, `o comando ${i + 1}`);
    const a = comando(st);
    achados.push(...a);
    porComando.push(a);
  });
  const avisos = achados.flatMap((a) => a.avisos ?? []);
  const comRls = new Set(achados.flatMap((a) => (a.ligouRls ? [a.ligouRls] : [])));
  const tabelasCriadas = achados.flatMap((a) => (a.criou ? [a.criou] : []));
  for (const t of tabelasCriadas) {
    avisos.push(
      comRls.has(t)
        ? `a tabela ${t} nasce com segurança por linha (RLS) ligada: sem política, só a chave de serviço enxerga as linhas; crie as CREATE POLICY para os usuários da tela`
        : `a tabela ${t} nasce SEM segurança por linha: o servidor liga a RLS nela sozinho (sem política, só a chave de serviço enxerga as linhas); crie as CREATE POLICY para os usuários da tela`,
    );
  }
  const alvosDeEscrita: AnaliseSql['alvosDeEscrita'] = [];
  const comandos: ComandoSql[] = [];
  porComando.forEach((lista, idx) => {
    for (const a of lista) {
      comandos.push({ n: idx + 1, tipo: a.tipo, acao: a.acao, o_que: a.o_que, ...(a.criou ? { criou: a.criou } : {}), ...(a.matview ? { matview: a.matview } : {}), ...(a.funcao ? { funcao: a.funcao } : {}) });
      if (a.alvo) alvosDeEscrita.push({ n: idx + 1, ...a.alvo });
    }
  });
  return {
    sql,
    trechos,
    comandos,
    decisao: achados.some((a) => a.acao === 'confirmar') ? 'confirmar' : 'direto',
    mudaEstrutura: achados.some((a) => a.estrutura === true),
    mudaDados: achados.some((a) => a.dados === true),
    precisaSnapshot: achados.some((a) => a.estrutura === true || (a.copiar ?? []).length > 0),
    tabelasParaCopiar: [...new Set(achados.flatMap((a) => a.copiar ?? []))],
    tabelasCriadas,
    matviewsCriadas: achados.flatMap((a) => (a.matview ? [a.matview] : [])),
    funcoesCriadas: [...new Set(achados.flatMap((a) => (a.funcao ? [a.funcao] : [])))],
    alvosDeEscrita,
    renomeia: achados.some((a) => a.renomeia === true),
    avisos: [...new Set(avisos)],
  };
}

