/**
 * ESTRUTURA POR CAMPOS (sem SQL livre): a Lia descreve uma tabela, uma coluna ou um índice por campos e ESTE arquivo gera o SQL.
 *
 * Este arquivo é IDÊNTICO nos dois repositórios (agente-dt: backend/src/mcp-remoto/estrutura-campos.ts; sistemas-dd: src/estrutura-campos.ts).
 * Um teste de cada lado trava o hash do arquivo e roda os MESMOS casos (estrutura-campos-casos.json). Mudou aqui, mude lá igualzinho.
 * Só funções puras, sem import: o conector usa para validar e MOSTRAR o SQL antes da aprovação; o servidor usa para validar DE NOVO,
 * gerar o mesmo SQL e executar (e recusa se o SQL gerado for diferente do que foi aprovado).
 *
 * Por que é seguro por construção: nada do que a pessoa escreve entra no SQL como texto solto. Nomes passam por `^[a-z][a-z0-9_]{1,40}$`
 * (e vão entre aspas duplas), tipos vêm de lista fechada, padrões são número, true/false, now()/current_date/gen_random_uuid() ou um texto
 * curto de caracteres seguros (sem aspa, sem barra, sem $). Não há como escrever DROP, subconsulta, função própria nem tocar tabela fechada.
 *
 * REGRA DE ACESSO POR MODELO FECHADO (0.1.10.8-pol): quem lê, quem cria e quem altera as linhas de uma tabela NOVA é escolhido numa lista de 4 modelos (REGRAS), tirada das políticas que
 * o banco de produção já usa (caixa_semaforo, caixa_lanc, fin_*, rh_docs). A pessoa nunca escreve expressão: o modelo é uma chave da lista, e a única coisa que ela informa além dele é o NOME de
 * uma coluna de unidade (mesma regra de nomes, e a coluna tem de existir e ser text). Os grants da tabela nova também saem daqui, explícitos (não dependem de default privileges).
 * A troca de modelo (tipo "regra") só vale para tabela de dono rh_ddl, isto é, criada por este caminho: quem confere o dono é o servidor, no banco.
 */

export class ErroEstrutura extends Error {}

export interface ColunaEntrada {
  nome?: unknown;
  tipo?: unknown;
  obrigatoria?: unknown;
  padrao?: unknown;
  unica?: unknown;
}
export interface TabelaExistente {
  /** nº de linhas (null = não sei: trata como "tem linhas") */
  linhas: number | null;
  colunas: string[];
  /** tipo (information_schema.data_type, ex.: "text") de cada coluna; ausente = quem montou não sabe (a prévia do conector em servidor antigo) */
  tipos?: Map<string, string>;
  /** dono da tabela no banco (pg_class.relowner); ausente = não sei. O servidor SEMPRE informa e a troca de regra só vale para `rh_ddl` */
  dono?: string;
  /** r = tabela comum; só ela aceita troca de regra */
  relkind?: string;
  /** nomes das políticas que a tabela tem hoje */
  politicas?: string[];
}
/** O que já existe no banco (só as tabelas que importam para o pedido). */
export interface Existentes {
  tabelas: Map<string, TabelaExistente>;
}
export interface Plano {
  tipo: 'tabela' | 'coluna' | 'indice' | 'regra';
  tabela: string;
  /** os comandos, na ordem; é isto que é mostrado, aprovado e executado */
  sql: string[];
  resumo: string[];
  avisos: string[];
  /** nome do índice que o plano cria (só no tipo "indice"): o servidor recusa se já existir objeto com este nome (o corte em 63 caracteres pode colidir) */
  criaIndice?: string;
  /** tipos "tabela" e "regra": o que o servidor tem de encontrar no banco DEPOIS de executar (políticas e privilégios); se não bater, desfaz tudo */
  conferencia?: Conferencia;
  /** tipos "tabela" e "regra": o modelo aplicado e a coluna de unidade (null nos modelos sem unidade) */
  regra?: { modelo: string; colunaUnidade: string | null };
}
export interface PoliticaEsperada {
  nome: string;
  cmd: 'SELECT' | 'INSERT' | 'UPDATE';
  /** expressão USING como o Postgres a devolve (sem "public." nem aspas) ou null */
  usando: string | null;
  comCheck: string | null;
}
export interface Conferencia {
  tabela: string;
  politicas: PoliticaEsperada[];
  /** privilégios que a tabela tem de ter, fora o dono: [papel, privilégio], e NADA além disso */
  privilegios: Array<[string, string]>;
}

// ------------------------------------------------------------------ regras

const NOME = /^[a-z][a-z0-9_]{1,40}$/;
const TEXTO_SEGURO = /^[A-Za-z0-9À-ÿ _.,:;/()%@#+=?!-]{0,60}$/;

/** Tabelas e prefixos que não se criam nem se alteram por aqui: usuários, documentos, registros, página do RH, administração, esquemas do sistema. */
const FECHADOS_PREFIXO = ['rh_usuarios', 'rh_docs', 'rh_log', 'rh_site', 'admin_', 'auth', 'storage', 'pg_', 'sql_', 'supabase', 'realtime', 'vault', 'extensions', 'graphql', 'cron_', 'information_schema', 'pgsodium', 'pgbouncer'];
const COLUNAS_DO_SISTEMA = ['tableoid', 'cmin', 'cmax', 'xmin', 'xmax', 'ctid'];

/** Lista fechada de tipos: o que a pessoa escreve (chave) e o que vai para o SQL. */
const TIPOS: Record<string, string> = {
  text: 'text',
  integer: 'integer',
  bigint: 'bigint',
  'numeric(12,2)': 'numeric(12,2)',
  boolean: 'boolean',
  date: 'date',
  timestamptz: 'timestamptz',
  uuid: 'uuid',
  jsonb: 'jsonb',
};
export const TIPOS_ACEITOS = Object.keys(TIPOS);

const MAX_COLUNAS = 30;
const MAX_COLUNAS_INDICE = 4;

/** "cron" é o esquema do pg_cron; o prefixo é "cron_" para não fechar nomes legítimos como cronograma_* (03/11, revisão do sênior). */
export const nomeFechado = (nome: string): boolean => nome === 'cron' || FECHADOS_PREFIXO.some((p) => nome.startsWith(p));

function recusa(msg: string): never {
  throw new ErroEstrutura(msg);
}

const q = (nome: string): string => `"${nome}"`;

function nomeValido(v: unknown, o: string): string {
  if (typeof v !== 'string' || !NOME.test(v)) {
    recusa(`${o}: use minúsculas, números e "_", começando por letra, de 2 a 41 caracteres (recebi ${JSON.stringify(typeof v === 'string' ? v.slice(0, 50) : v)})`);
  }
  return v;
}

function tipoValido(v: unknown, o: string): string {
  const t = typeof v === 'string' ? v.toLowerCase().replace(/\s+/g, '') : '';
  if (!Object.hasOwn(TIPOS, t)) recusa(`${o}: tipo "${typeof v === 'string' ? v.slice(0, 30) : v}" não é permitido. Tipos aceitos: ${TIPOS_ACEITOS.join(', ')}`);
  return t;
}

function booleano(v: unknown, o: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') recusa(`${o}: use true ou false`);
  return v;
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const DATA_HORA = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** O padrão da coluna, como texto de SQL, validado pelo tipo. Devolve null quando não há padrão. */
function padraoValido(tipo: string, v: unknown, o: string): string | null {
  if (v === undefined || v === null) return null;
  const ruim = (dica: string): never => recusa(`${o}: o padrão ${JSON.stringify(typeof v === 'string' ? v.slice(0, 40) : v)} não serve para ${tipo}. ${dica}`);
  switch (tipo) {
    case 'text':
      if (typeof v !== 'string') return ruim('Use um texto curto.');
      if (!TEXTO_SEGURO.test(v)) return ruim('Texto de até 60 caracteres, só letras, números, espaço e . , : ; / ( ) % @ # + = ? ! - (sem aspas, barra invertida nem $).');
      return `'${v}'`;
    case 'integer':
    case 'bigint': {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return ruim('Use um número inteiro.');
      if (tipo === 'integer' && Math.abs(v) > 2_147_483_647) return ruim('Fora do limite de integer.');
      return String(v);
    }
    case 'numeric(12,2)': {
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) >= 1e10) return ruim('Use um número (até 2 casas decimais).');
      if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return ruim('Use no máximo 2 casas decimais.');
      return v.toFixed(2);
    }
    case 'boolean':
      if (typeof v !== 'boolean') return ruim('Use true ou false.');
      return v ? 'true' : 'false';
    case 'date':
      if (v === 'current_date') return 'current_date';
      if (typeof v !== 'string' || !DATA.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return ruim('Use "current_date" ou uma data AAAA-MM-DD.');
      return `'${v}'`;
    case 'timestamptz':
      if (v === 'now()') return 'now()';
      if (typeof v !== 'string' || !DATA_HORA.test(v) || Number.isNaN(Date.parse(v.replace(' ', 'T')))) return ruim('Use "now()" ou um instante AAAA-MM-DDThh:mm[:ss][Z].');
      return `'${v}'`;
    case 'uuid':
      if (v === 'gen_random_uuid()') return 'gen_random_uuid()';
      if (typeof v !== 'string' || !UUID.test(v)) return ruim('Use "gen_random_uuid()" ou um uuid.');
      return `'${v}'`;
    case 'jsonb':
      if (v !== '{}' && v !== '[]') return ruim('Use "{}" ou "[]".');
      return `'${v}'::jsonb`;
    default:
      return ruim('Tipo desconhecido.');
  }
}

interface ColunaPronta {
  nome: string;
  tipo: string;
  obrigatoria: boolean;
  unica: boolean;
  padrao: string | null;
}

function colunaPronta(c: unknown, o: string): ColunaPronta {
  if (!c || typeof c !== 'object' || Array.isArray(c)) recusa(`${o}: esperava { nome, tipo, obrigatoria?, padrao?, unica? }`);
  const x = c as ColunaEntrada;
  for (const k of Object.keys(x)) if (!['nome', 'tipo', 'obrigatoria', 'padrao', 'unica'].includes(k)) recusa(`${o}: o campo "${k}" não existe (use nome, tipo, obrigatoria, padrao, unica)`);
  const nome = nomeValido(x.nome, `${o} (nome)`);
  if (COLUNAS_DO_SISTEMA.includes(nome)) recusa(`${o}: "${nome}" é nome reservado do Postgres`);
  const tipo = tipoValido(x.tipo, `coluna ${nome}`);
  return { nome, tipo, obrigatoria: booleano(x.obrigatoria, `coluna ${nome} (obrigatoria)`), unica: booleano(x.unica, `coluna ${nome} (unica)`), padrao: padraoValido(tipo, x.padrao, `coluna ${nome} (padrao)`) };
}

const definicao = (c: ColunaPronta, extra = ''): string =>
  `${q(c.nome)} ${TIPOS[c.tipo]}${extra}${c.obrigatoria ? ' not null' : ''}${c.padrao !== null ? ` default ${c.padrao}` : ''}${c.unica ? ' unique' : ''}`;

function tabelaAlvo(nome: unknown, ex: Existentes, o: string): { nome: string; info: TabelaExistente } {
  const t = nomeValido(nome, o);
  if (nomeFechado(t)) recusa(`${o}: "${t}" é tabela fechada (usuários, documentos, registros, página do RH, administração e esquemas do sistema não se alteram por aqui)`);
  const info = ex.tabelas.get(t);
  if (!info) recusa(`${o}: a tabela "${t}" não existe`);
  return { nome: t, info };
}

// ------------------------------------------------------------------ regras de acesso (modelos fechados)

/** O dono das tabelas criadas por este caminho (migration 072). A troca de regra só vale para tabela dele. */
export const DONO_DDL = 'rh_ddl';

type Funcao = 'caixa_pode' | 'caixa_gestor' | 'rh_admin';
interface Termo {
  fn: Funcao;
  /** true = recebe a coluna da unidade como argumento */
  unidade: boolean;
}
export interface ModeloDeRegra {
  descricao: string;
  precisaUnidade: boolean;
  sel: Termo;
  ins: Termo;
  upd: Termo;
}
const POR_UNIDADE: Termo = { fn: 'caixa_pode', unidade: true };
const GESTAO: Termo = { fn: 'caixa_gestor', unidade: false };
const ADMIN: Termo = { fn: 'rh_admin', unidade: false };

/**
 * Os 4 modelos, tirados das políticas que o banco real já usa (medido em produção em 05/11/2026):
 *  - caixa_semaforo, caixa_unidades, caixa_trat: lê `caixa_pode(unidade)`, grava `caixa_gestor()`     => unidade_le_gestao_grava
 *  - caixa_lanc, caixa_docs: a unidade também INSERE (com travas próprias de status/autor, que não cabem num modelo genérico) => unidade_le_e_lanca
 *  - portal_vinculo, caixa_prev: só `caixa_gestor()` (admin, gestão e financeiro)                       => gestao_e_financeiro
 *  - rh_docs, rh_log, rh_usuarios: só `rh_admin()` (admin e gestão, SEM o financeiro)                   => so_admin_e_gestao
 * Nenhum modelo dá DELETE: ninguém apaga pela tela (apagar é do servidor). As funções são as que o banco já tem (SECURITY DEFINER, search_path fixo).
 */
export const REGRAS: Readonly<Record<string, ModeloDeRegra>> = Object.freeze({
  unidade_le_gestao_grava: { descricao: 'a gestão vê, cria e altera tudo; a própria unidade só VÊ as linhas da sua unidade (como caixa_semaforo)', precisaUnidade: true, sel: POR_UNIDADE, ins: GESTAO, upd: GESTAO },
  unidade_le_e_lanca: { descricao: 'a gestão vê, cria e altera tudo; a própria unidade VÊ e CRIA linhas da sua unidade, com QUALQUER valor nas demais colunas (id, criado_em, status, valores: SEM as travas de status e autor da caixa_lanc); não altera nem apaga', precisaUnidade: true, sel: POR_UNIDADE, ins: POR_UNIDADE, upd: GESTAO },
  gestao_e_financeiro: { descricao: 'só admin, gestão e financeiro veem, criam e alteram; unidade nenhuma (como portal_vinculo)', precisaUnidade: false, sel: GESTAO, ins: GESTAO, upd: GESTAO },
  so_admin_e_gestao: { descricao: 'só admin e gestão veem, criam e alteram; o financeiro e as unidades nada (como rh_docs)', precisaUnidade: false, sel: ADMIN, ins: ADMIN, upd: ADMIN },
});
export const REGRAS_ACEITAS = Object.keys(REGRAS);

/** Quem a tabela nova enxerga no banco, e com quê. O dono (rh_ddl) fica de fora da conta. Qualquer coisa além disto reprova a conferência. */
export const PRIVILEGIOS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['authenticated', 'SELECT'], ['authenticated', 'INSERT'], ['authenticated', 'UPDATE'],
  ['service_role', 'SELECT'], ['service_role', 'INSERT'], ['service_role', 'UPDATE'], ['service_role', 'DELETE'],
  ['mcp_leitor', 'SELECT'],
  ['mcp_consulta_rh', 'SELECT'],
]);

const expressao = (t: Termo, col: string | null, comAspas: boolean): string => {
  if (!t.unidade) return `${t.fn}()`;
  if (col === null) recusa('erro interno: modelo de unidade sem coluna');
  return `${t.fn}(${comAspas ? q(col) : col})`;
};

interface RegraResolvida {
  id: string;
  modelo: ModeloDeRegra;
  colunaUnidade: string | null;
}

/** `tipoDe(nome)`: tipo da coluna, undefined = coluna não existe, null = existe mas não sei o tipo (prévia do conector em servidor antigo). */
function resolverRegra(regra: unknown, coluna: unknown, tipoDe: (c: string) => string | undefined | null, padrao: string | null, o: string): RegraResolvida {
  let id: string;
  if (regra === undefined || regra === null) {
    if (padrao === null) recusa(`${o}: informe a regra (uma de: ${REGRAS_ACEITAS.join(', ')})`);
    id = padrao;
  } else {
    if (typeof regra !== 'string' || !Object.hasOwn(REGRAS, regra)) recusa(`${o}: a regra "${typeof regra === 'string' ? regra.slice(0, 40) : regra}" não existe. Regras aceitas: ${REGRAS_ACEITAS.join(', ')}`);
    id = regra;
  }
  const modelo = REGRAS[id];
  if (!modelo.precisaUnidade) {
    if (coluna !== undefined && coluna !== null) recusa(`${o}: a regra ${id} não usa coluna de unidade (tire "coluna_unidade")`);
    return { id, modelo, colunaUnidade: null };
  }
  const col = nomeValido(coluna === undefined || coluna === null ? 'unidade' : coluna, `${o} (coluna_unidade)`);
  const tipo = tipoDe(col);
  if (tipo === undefined) recusa(`${o}: a regra ${id} filtra pela unidade e a coluna "${col}" não existe na tabela (informe coluna_unidade com o nome certo)`);
  if (tipo !== null && tipo !== 'text') recusa(`${o}: a coluna de unidade "${col}" tem de ser text (é ${tipo}): o valor é o slug da unidade, como em caixa_lanc.unidade`);
  return { id, modelo, colunaUnidade: col };
}

/** Políticas, privilégios e conferência de uma regra. As políticas sempre se chamam <tabela>_sel, _ins e _upd e valem só para `authenticated`. */
export const nomesDePolitica = (tabela: string): string[] => [`${tabela}_sel`, `${tabela}_ins`, `${tabela}_upd`];

function sqlDaRegra(tabela: string, r: RegraResolvida): { sql: string[]; conferencia: Conferencia } {
  const T = `public.${q(tabela)}`;
  const m = r.modelo;
  const [nSel, nIns, nUpd] = nomesDePolitica(tabela);
  const sel = expressao(m.sel, r.colunaUnidade, true);
  const ins = expressao(m.ins, r.colunaUnidade, true);
  const upd = expressao(m.upd, r.colunaUnidade, true);
  const sql = [
    `alter table ${T} enable row level security`,
    `create policy ${q(nSel)} on ${T} for select to authenticated using (public.${sel})`,
    `create policy ${q(nIns)} on ${T} for insert to authenticated with check (public.${ins})`,
    `create policy ${q(nUpd)} on ${T} for update to authenticated using (public.${upd}) with check (public.${upd})`,
    `revoke all on table ${T} from public, anon, authenticated, service_role, mcp_leitor, mcp_consulta_rh`,
    `grant select, insert, update on table ${T} to authenticated`,
    `grant select, insert, update, delete on table ${T} to service_role`,
    `grant select on table ${T} to mcp_leitor, mcp_consulta_rh`,
  ];
  const sem = (c: string | null) => expressao(m.sel, c, false);
  const conferencia: Conferencia = {
    tabela,
    politicas: [
      { nome: nSel, cmd: 'SELECT', usando: sem(r.colunaUnidade), comCheck: null },
      { nome: nIns, cmd: 'INSERT', usando: null, comCheck: expressao(m.ins, r.colunaUnidade, false) },
      { nome: nUpd, cmd: 'UPDATE', usando: expressao(m.upd, r.colunaUnidade, false), comCheck: expressao(m.upd, r.colunaUnidade, false) },
    ],
    privilegios: PRIVILEGIOS.map(([a, b]) => [a, b] as [string, string]),
  };
  return { sql, conferencia };
}

/** Avisos que valem sempre que o modelo é este (a prévia mostra; o texto da descrição do modelo sozinho não basta). */
function avisosDaRegra(r: RegraResolvida, temColunaUnica: boolean): string[] {
  if (r.id !== 'unidade_le_e_lanca') return [];
  const a = ['unidade_le_e_lanca NÃO tem as travas de status e de autor da caixa_lanc: a unidade cria a linha com QUALQUER valor nas demais colunas. Se a tabela tem coluna de aprovação, status ou valor que só a gestão deveria definir, a unidade a preenche sozinha: nesse caso use unidade_le_gestao_grava'];
  if (temColunaUnica) a.push('regra unidade_le_e_lanca com coluna ÚNICA: uma unidade que tente criar um valor já usado por OUTRA unidade recebe erro de duplicidade e assim descobre que o valor existe; use índice único com a coluna da unidade junto, ou outra regra');
  return a;
}

function resumoDaRegra(tabela: string, r: RegraResolvida): string[] {
  const col = r.colunaUnidade;
  return [
    `Regra de acesso "${r.id}" em ${tabela}: ${r.modelo.descricao}${col ? ` (a unidade é a coluna ${col})` : ''}.`,
    `Liga a segurança por linha (RLS) e cria as 3 políticas ${nomesDePolitica(tabela).join(', ')} (só para quem entra pela tela); ninguém apaga pela tela. Privilégios da tabela: tela (authenticated) lê, cria e altera; servidor (service_role) lê, cria, altera e apaga; leitura da Lia (mcp_leitor, mcp_consulta_rh) só lê, e LÊ TODAS AS LINHAS (é a consulta de gestão); anônimo nada.`,
  ];
}

// ------------------------------------------------------------------ planos

export function planejarTabela(e: { nome?: unknown; colunas?: unknown; regra?: unknown; coluna_unidade?: unknown }, ex: Existentes): Plano {
  const nome = nomeValido(e.nome, 'nome da tabela');
  if (nomeFechado(nome)) recusa(`nome da tabela: "${nome}" começa como uma tabela fechada (rh_usuarios, rh_docs, rh_log, rh_site*, admin_*, auth*, storage*, pg_*…): escolha outro nome`);
  if (ex.tabelas.has(nome)) recusa(`a tabela "${nome}" já existe: para acrescentar coluna use sistemas_preparar_coluna`);
  if (!Array.isArray(e.colunas) || e.colunas.length < 1) recusa('colunas: informe ao menos uma coluna');
  if (e.colunas.length > MAX_COLUNAS) recusa(`colunas: no máximo ${MAX_COLUNAS} por tabela`);
  const colunas = e.colunas.map((c, i) => colunaPronta(c, `coluna ${i + 1}`));
  const vistos = new Set<string>();
  for (const c of colunas) {
    if (vistos.has(c.nome)) recusa(`coluna "${c.nome}" repetida`);
    vistos.add(c.nome);
  }
  const id = colunas.find((c) => c.nome === 'id');
  if (id && id.tipo !== 'uuid') recusa('coluna "id": se informar, tem de ser uuid (a tabela sempre tem id uuid como chave)');
  const criado = colunas.find((c) => c.nome === 'criado_em');
  if (criado && criado.tipo !== 'timestamptz') recusa('coluna "criado_em": se informar, tem de ser timestamptz');
  // sem "regra" o comportamento de sempre: com coluna "unidade" (text) a unidade vê; sem ela, só a gestão. Com "regra", o modelo escolhido e a coluna conferida (existir e ser text).
  const tipoDe = (c: string): string | undefined => colunas.find((x) => x.nome === c)?.tipo;
  const padrao = tipoDe('unidade') === 'text' ? 'unidade_le_gestao_grava' : 'gestao_e_financeiro';
  const regra = resolverRegra(e.regra, e.coluna_unidade, tipoDe, padrao, 'regra');
  const partes: string[] = [];
  partes.push(`"id" uuid primary key default ${id?.padrao ?? 'gen_random_uuid()'}`);
  if (!criado) partes.push('"criado_em" timestamptz not null default now()');
  for (const c of colunas) {
    if (c === id) continue;
    partes.push(c === criado ? definicao({ ...c, obrigatoria: true, padrao: c.padrao ?? 'now()' }) : definicao(c));
  }
  const t = q(nome);
  const dr = sqlDaRegra(nome, regra);
  const sql = [`create table public.${t} (${partes.join(', ')})`, ...dr.sql];
  const resumo = [
    `Cria a tabela ${nome} com ${colunas.length + (id ? 0 : 1) + (criado ? 0 : 1)} colunas: ${[...(id ? [] : ['id (uuid, chave)']), ...(criado ? [] : ['criado_em (timestamptz, agora)']), ...colunas.map((c) => `${c.nome} (${c.tipo}${c.obrigatoria ? ', obrigatória' : ''}${c.unica ? ', única' : ''}${c.padrao !== null ? `, padrão ${c.padrao}` : ''})`)].join('; ')}.`,
    ...resumoDaRegra(nome, regra),
  ];
  const avisos = avisosDaRegra(regra, colunas.some((c) => c.unica));
  return { tipo: 'tabela', tabela: nome, sql, resumo, avisos, conferencia: dr.conferencia, regra: { modelo: regra.id, colunaUnidade: regra.colunaUnidade } };
}

/**
 * Troca a regra de acesso de uma tabela que ESTE caminho criou (dono rh_ddl). Tabela de outro dono (fin_lanc, rh_docs, portal_vinculo, caixa_lanc, auth*, storage*…)
 * é recusada aqui e, se este teste fosse burlado, o próprio Postgres recusaria: rh_ddl não é dono delas e não pode mexer na política.
 */
export function planejarRegra(e: { tabela?: unknown; regra?: unknown; coluna_unidade?: unknown }, ex: Existentes): Plano {
  const alvo = tabelaAlvo(e.tabela, ex, 'tabela');
  const info = alvo.info;
  // ATENÇÃO: o banco NÃO é a segunda trava aqui. O papel rh_ddl herda a posse de tudo que é do dono original (`grant sistemas to rh_ddl with inherit true`, migration 060): ele CONSEGUIRIA
  // trocar a política de fin_lanc. Quem impede é esta checagem do dono, que o servidor refaz no catálogo, com a tabela travada, antes de executar. Não a afrouxe.
  if (info.dono !== undefined && info.dono !== DONO_DDL) recusa(`a tabela "${alvo.nome}" não foi criada por este caminho (o dono é ${info.dono}): a regra dela só o João muda, no servidor`);
  if (info.relkind !== undefined && info.relkind !== 'r') recusa(`"${alvo.nome}" não é uma tabela comum: a regra só vale para tabela`);
  const nossas = nomesDePolitica(alvo.nome);
  const estranhas = (info.politicas ?? []).filter((n) => !nossas.includes(n));
  if (estranhas.length) recusa(`a tabela "${alvo.nome}" tem política que este caminho não criou (${estranhas.slice(0, 5).join(', ')}): para não apagar regra de outra origem, a troca fica com o João, no servidor`);
  if (e.regra === undefined || e.regra === null) recusa(`regra: informe a regra (uma de: ${REGRAS_ACEITAS.join(', ')})`);
  const tipoDe = (c: string): string | undefined | null => {
    if (!info.colunas.includes(c)) return undefined;
    return info.tipos ? (info.tipos.get(c) ?? null) : null;
  };
  const regra = resolverRegra(e.regra, e.coluna_unidade, tipoDe, null, 'regra');
  const dr = sqlDaRegra(alvo.nome, regra);
  const sql = [
    ...nomesDePolitica(alvo.nome).map((n) => `drop policy if exists ${q(n)} on public.${q(alvo.nome)}`),
    ...dr.sql,
  ];
  const avisos: string[] = [`as políticas atuais de ${alvo.nome} são guardadas em admin_backup antes da troca (para desfazer à mão)`, ...avisosDaRegra(regra, false)];
  if (info.politicas && info.politicas.length === 0) avisos.push(`${alvo.nome} não tem política nenhuma hoje: com RLS ligada e sem política ninguém da tela enxerga nada; esta troca dá a regra escolhida`);
  if (info.linhas === null || info.linhas > 0) avisos.push(`${alvo.nome} já tem linhas: quem passa a poder ver muda NA HORA para todas elas`);
  return { tipo: 'regra', tabela: alvo.nome, sql, resumo: resumoDaRegra(alvo.nome, regra), avisos, conferencia: dr.conferencia, regra: { modelo: regra.id, colunaUnidade: regra.colunaUnidade } };
}

export function planejarColuna(e: { tabela?: unknown; coluna?: unknown }, ex: Existentes): Plano {
  const alvo = tabelaAlvo(e.tabela, ex, 'tabela');
  const c = colunaPronta(e.coluna, 'coluna');
  if (alvo.info.colunas.includes(c.nome)) recusa(`a coluna "${c.nome}" já existe na tabela ${alvo.nome}`);
  const temLinhas = alvo.info.linhas === null || alvo.info.linhas > 0;
  if (temLinhas && c.obrigatoria && c.padrao === null) {
    recusa(`a tabela ${alvo.nome} já tem linhas${alvo.info.linhas === null ? ' (não consegui contar)' : ` (${alvo.info.linhas})`}: coluna obrigatória precisa de "padrao" para preencher as linhas que já existem`);
  }
  if (temLinhas && c.unica && c.padrao !== null && c.padrao !== 'gen_random_uuid()') recusa(`coluna única com padrão fixo em tabela que já tem linhas repetiria o mesmo valor em todas: tire "unica" ou o "padrao"`);
  const sql = [`alter table public.${q(alvo.nome)} add column ${definicao(c)}`];
  const avisos: string[] = [];
  if (c.padrao !== null && temLinhas) avisos.push(`as linhas que já existem em ${alvo.nome} recebem o padrão ${c.padrao}`);
  return {
    tipo: 'coluna',
    tabela: alvo.nome,
    sql,
    resumo: [`Acrescenta a coluna ${c.nome} (${c.tipo}${c.obrigatoria ? ', obrigatória' : ''}${c.unica ? ', única' : ''}${c.padrao !== null ? `, padrão ${c.padrao}` : ''}) na tabela ${alvo.nome}.`],
    avisos,
  };
}

/**
 * Nome do índice: tabela_colunas_idx|uq, cortado em 63 (limite do Postgres). O corte pode fazer DOIS índices diferentes terem o mesmo nome; como o comando é
 * `create index if not exists`, o segundo seria ignorado em silêncio com ok:true. Quem executa (o servidor) confere se já existe objeto com este nome e recusa.
 */
export const nomeDoIndice = (tabela: string, cols: string[], unico: boolean): string => `${tabela}_${cols.join('_')}_${unico ? 'uq' : 'idx'}`.slice(0, 63);

export function planejarIndice(e: { tabela?: unknown; colunas?: unknown; unico?: unknown }, ex: Existentes): Plano {
  const alvo = tabelaAlvo(e.tabela, ex, 'tabela');
  if (!Array.isArray(e.colunas) || e.colunas.length < 1 || e.colunas.length > MAX_COLUNAS_INDICE) recusa(`colunas: informe de 1 a ${MAX_COLUNAS_INDICE} colunas do índice`);
  const cols = e.colunas.map((c, i) => nomeValido(c, `coluna ${i + 1} do índice`));
  if (new Set(cols).size !== cols.length) recusa('coluna repetida no índice');
  for (const c of cols) if (!alvo.info.colunas.includes(c)) recusa(`a coluna "${c}" não existe na tabela ${alvo.nome}`);
  const unico = booleano(e.unico, 'unico');
  const nomeIndice = nomeDoIndice(alvo.nome, cols, unico);
  const sql = [`create ${unico ? 'unique ' : ''}index if not exists ${q(nomeIndice)} on public.${q(alvo.nome)} (${cols.map(q).join(', ')})`];
  return {
    tipo: 'indice',
    tabela: alvo.nome,
    criaIndice: nomeIndice,
    sql,
    resumo: [`Cria o índice${unico ? ' ÚNICO' : ''} ${nomeIndice} em ${alvo.nome} (${cols.join(', ')}).`],
    avisos: unico ? ['índice único falha se já houver valores repetidos nessas colunas; se falhar nada muda'] : [],
  };
}

/** Despacha pelo `tipo` do pedido (é o que o servidor recebe). */
export function planejar(entrada: Record<string, unknown>, ex: Existentes): Plano {
  switch (entrada.tipo) {
    case 'tabela':
      return planejarTabela(entrada as { nome?: unknown; colunas?: unknown; regra?: unknown; coluna_unidade?: unknown }, ex);
    case 'coluna':
      return planejarColuna(entrada as { tabela?: unknown; coluna?: unknown }, ex);
    case 'indice':
      return planejarIndice(entrada as { tabela?: unknown; colunas?: unknown; unico?: unknown }, ex);
    case 'regra':
      return planejarRegra(entrada as { tabela?: unknown; regra?: unknown; coluna_unidade?: unknown }, ex);
    default:
      return recusa('tipo do pedido: use tabela, coluna, indice ou regra');
  }
}
