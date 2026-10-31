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
}
/** O que já existe no banco (só as tabelas que importam para o pedido). */
export interface Existentes {
  tabelas: Map<string, TabelaExistente>;
}
export interface Plano {
  tipo: 'tabela' | 'coluna' | 'indice';
  tabela: string;
  /** os comandos, na ordem; é isto que é mostrado, aprovado e executado */
  sql: string[];
  resumo: string[];
  avisos: string[];
}

// ------------------------------------------------------------------ regras

const NOME = /^[a-z][a-z0-9_]{1,40}$/;
const TEXTO_SEGURO = /^[A-Za-z0-9À-ÿ _.,:;/()%@#+=?!-]{0,60}$/;

/** Tabelas e prefixos que não se criam nem se alteram por aqui: usuários, documentos, registros, página do RH, administração, esquemas do sistema. */
const FECHADOS_PREFIXO = ['rh_usuarios', 'rh_docs', 'rh_log', 'rh_site', 'admin_', 'auth', 'storage', 'pg_', 'sql_', 'supabase', 'realtime', 'vault', 'extensions', 'graphql', 'cron', 'information_schema', 'pgsodium', 'pgbouncer'];
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

export const nomeFechado = (nome: string): boolean => FECHADOS_PREFIXO.some((p) => nome.startsWith(p));

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
  if (!(t in TIPOS)) recusa(`${o}: tipo "${typeof v === 'string' ? v.slice(0, 30) : v}" não é permitido. Tipos aceitos: ${TIPOS_ACEITOS.join(', ')}`);
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

// ------------------------------------------------------------------ planos

export function planejarTabela(e: { nome?: unknown; colunas?: unknown }, ex: Existentes): Plano {
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
  const partes: string[] = [];
  partes.push(`"id" uuid primary key default ${id?.padrao ?? 'gen_random_uuid()'}`);
  if (!criado) partes.push('"criado_em" timestamptz not null default now()');
  for (const c of colunas) {
    if (c === id) continue;
    partes.push(c === criado ? definicao({ ...c, obrigatoria: true, padrao: c.padrao ?? 'now()' }) : definicao(c));
  }
  const t = q(nome);
  const comUnidade = colunas.some((c) => c.nome === 'unidade' && c.tipo === 'text');
  const sql = [
    `create table public.${t} (${partes.join(', ')})`,
    `alter table public.${t} enable row level security`,
    `create policy ${q(`${nome}_sel`)} on public.${t} for select to authenticated using (${comUnidade ? 'public.caixa_pode(unidade)' : 'public.caixa_gestor()'})`,
    `create policy ${q(`${nome}_ins`)} on public.${t} for insert to authenticated with check (public.caixa_gestor())`,
    `create policy ${q(`${nome}_upd`)} on public.${t} for update to authenticated using (public.caixa_gestor()) with check (public.caixa_gestor())`,
  ];
  const resumo = [
    `Cria a tabela ${nome} com ${colunas.length + (id ? 0 : 1) + (criado ? 0 : 1)} colunas: ${[...(id ? [] : ['id (uuid, chave)']), ...(criado ? [] : ['criado_em (timestamptz, agora)']), ...colunas.map((c) => `${c.nome} (${c.tipo}${c.obrigatoria ? ', obrigatória' : ''}${c.unica ? ', única' : ''}${c.padrao !== null ? `, padrão ${c.padrao}` : ''})`)].join('; ')}.`,
    `Liga a segurança por linha (RLS) e cria as políticas padrão do Caixa: ${comUnidade ? 'quem vê é a gestão ou a própria unidade (coluna unidade, como em caixa_lanc)' : 'só a gestão (caixa_gestor) vê'}; só a gestão grava e altera; ninguém apaga pela tela (apagar só pelo servidor).`,
  ];
  return { tipo: 'tabela', tabela: nome, sql, resumo, avisos: [] };
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

export function planejarIndice(e: { tabela?: unknown; colunas?: unknown; unico?: unknown }, ex: Existentes): Plano {
  const alvo = tabelaAlvo(e.tabela, ex, 'tabela');
  if (!Array.isArray(e.colunas) || e.colunas.length < 1 || e.colunas.length > MAX_COLUNAS_INDICE) recusa(`colunas: informe de 1 a ${MAX_COLUNAS_INDICE} colunas do índice`);
  const cols = e.colunas.map((c, i) => nomeValido(c, `coluna ${i + 1} do índice`));
  if (new Set(cols).size !== cols.length) recusa('coluna repetida no índice');
  for (const c of cols) if (!alvo.info.colunas.includes(c)) recusa(`a coluna "${c}" não existe na tabela ${alvo.nome}`);
  const unico = booleano(e.unico, 'unico');
  const nomeIndice = `${alvo.nome}_${cols.join('_')}_${unico ? 'uq' : 'idx'}`.slice(0, 63);
  const sql = [`create ${unico ? 'unique ' : ''}index if not exists ${q(nomeIndice)} on public.${q(alvo.nome)} (${cols.map(q).join(', ')})`];
  return {
    tipo: 'indice',
    tabela: alvo.nome,
    sql,
    resumo: [`Cria o índice${unico ? ' ÚNICO' : ''} ${nomeIndice} em ${alvo.nome} (${cols.join(', ')}).`],
    avisos: unico ? ['índice único falha se já houver valores repetidos nessas colunas; se falhar nada muda'] : [],
  };
}

/** Despacha pelo `tipo` do pedido (é o que o servidor recebe). */
export function planejar(entrada: Record<string, unknown>, ex: Existentes): Plano {
  switch (entrada.tipo) {
    case 'tabela':
      return planejarTabela(entrada as { nome?: unknown; colunas?: unknown }, ex);
    case 'coluna':
      return planejarColuna(entrada as { tabela?: unknown; coluna?: unknown }, ex);
    case 'indice':
      return planejarIndice(entrada as { tabela?: unknown; colunas?: unknown; unico?: unknown }, ex);
    default:
      return recusa('tipo do pedido: use tabela, coluna ou indice');
  }
}
