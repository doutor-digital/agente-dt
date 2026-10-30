/**
 * Alterar a ESTRUTURA do banco do sistema novo (tabelas, colunas, índices, views, políticas) pelo claude.ai, em dois passos:
 * `sistemas_preparar_estrutura(sql, motivo)` confere o SQL, devolve o que ele cria/altera e um código; `sistemas_confirmar_estrutura`
 * com o código manda o SQL ao servidor (`POST /admin/v1/estrutura`, que roda a função `admin_sql` do banco). DROP não existe.
 *
 * As travas do banco (admin_sql: papel sem superusuário, recusa de DROP/TRUNCATE/auth/storage…) são a defesa de verdade; esta
 * é a segunda camada, MAIS ESTREITA: lista do que se aceita, e o que não se reconhece é recusado com o que reescrever.
 * Não é um parser de SQL — por isso é uma lista de formas conhecidas, não uma lista de proibições. Só quem está em
 * MCP_ESCRITA_EMAILS vê as ferramentas (o portão fica em producao.ts, junto com as outras escritas).
 *
 * Contrato que o servidor precisa ter (docs/ADMIN-API.md do sistemas-dd):
 *   POST /admin/v1/estrutura   corpo { sql, quem, motivo? }   resposta 200 { ok:true } | { ok:false, erro }
 *   (chama admin_sql(sql) como service_role e grava `quem` em admin_log; 4xx/5xx = { erro })
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { executar } from './ferramenta.js';
import { esqueletoDoSql, resolverSistema, VALIDADE_MS, type ContextoSistemas, type PendentesSistemas, type QuemSistemas, type Saida } from './sistemas.js';

const MAX_SQL = 20_000;
const MAX_COMANDOS = 25;

// ------------------------------------------------------------------ pré-checagem do SQL

export interface ComandoEstrutura {
  n: number;
  tipo: string;
  o_que: string;
}
export interface AnaliseEstrutura {
  /** o SQL como veio (o que vai ao servidor) */
  sql: string;
  comandos: ComandoEstrutura[];
  avisos: string[];
}

const ACEITO =
  'Aceito: CREATE TABLE, CREATE INDEX, CREATE VIEW (com security_invoker), ALTER TABLE (ADD COLUMN, ADD CONSTRAINT, ALTER COLUMN SET DEFAULT/TYPE/NOT NULL, ENABLE ROW LEVEL SECURITY), ' +
  'CREATE/ALTER POLICY, COMMENT ON e GRANT/REVOKE de SELECT/INSERT/UPDATE/DELETE para authenticated ou service_role. O resto (funções, gatilhos, renomear, apagar) é com quem administra o servidor.';

const ID = '[a-z_][a-z0-9_$]*';
const OBJ = `(?:${ID}\\.)?${ID}`;

/** Esquemas que não se tocam nem se leem por aqui (login, arquivos, catálogo, extensões). */
const ESQUEMA_PROIBIDO = /\b(auth|storage|extensions|realtime|vault|graphql|graphql_public|information_schema|cron|net|pgsodium|pgbouncer|supabase_[a-z_]+|pg_[a-z0-9_]+)\s*\./;

const PAPEIS_DA_APP = '(?:authenticated|service_role)';
const LISTA_PAPEIS = `${PAPEIS_DA_APP}(?:\\s*,\\s*${PAPEIS_DA_APP})*`;
const RE = {
  constraint: new RegExp(`^add (?:constraint (${ID}) )?(primary key|unique|check|foreign key|exclude)\\b`),
  coluna: new RegExp(`^add (?:column )?(if not exists )?(${ID}) (.+)$`),
  default: new RegExp(`^alter (?:column )?(${ID}) set default\\b`),
  naoNulo: new RegExp(`^alter (?:column )?(${ID}) set not null$`),
  tipo: new RegExp(`^alter (?:column )?(${ID}) (?:set data )?type\\b`),
  tabela: new RegExp(`^create (?:unlogged )?table (if not exists )?(${OBJ})\\b`),
  indice: new RegExp(`^create (unique )?index (?:if not exists )?(?:(${ID}) )?on (?:only )?(${OBJ})\\b`),
  // a opção tem de estar na cláusula WITH da view (depois do nome e da lista de colunas, antes do AS)
  view: new RegExp(`^create (or replace )?view (${OBJ}) (?:\\([^)]*\\) )?with \\([^)]*\\bsecurity_invoker\\s*=\\s*(?:true|on|1)\\b[^)]*\\) as\\b`),
  viewSemOpcao: new RegExp(`^create (or replace )?view (${OBJ})\\b`),
  alterTable: new RegExp(`^alter table (?:if exists )?(?:only )?(${OBJ}) (.+)$`),
  politica: new RegExp(`^(create|alter) policy (${ID}) on (${OBJ})(?: as (?:permissive|restrictive))?(?: for (?:all|select|insert|update|delete))?(?: to ([^()]*?))?(?: using| with check|$)`),
  comentario: /^comment on (table|column|index|view|constraint|policy|sequence) (.+?) is\b/,
  concede: new RegExp(`^(grant|revoke) ((?:select|insert|update|delete|usage)(?:\\s*,\\s*(?:select|insert|update|delete|usage))*) on (?:table |sequence )?(${OBJ}(?:\\s*,\\s*${OBJ})*) (?:to|from) (${LISTA_PAPEIS})$`),
};

function recusa(msg: string): never {
  throw new ErroDeEntrada(msg);
}

/** O nome de objeto precisa ser do esquema da app (`public`, explícito ou não). Devolve só o nome da tabela. */
function nomeDaApp(obj: string, como: string): string {
  const [a, b] = obj.split('.');
  if (b === undefined) return a!;
  if (a !== 'public') recusa(`${como}: só o esquema "public" é permitido (recebi "${a}.${b}")`);
  return b;
}

/** Divide por vírgula fora de parênteses (as ações de um ALTER TABLE). */
function partirPorVirgula(s: string): string[] {
  const partes: string[] = [];
  let nivel = 0;
  let atual = '';
  for (const c of s) {
    if (c === '(') nivel++;
    else if (c === ')') nivel--;
    if (c === ',' && nivel === 0) {
      partes.push(atual.trim());
      atual = '';
    } else atual += c;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes;
}

interface Achado {
  tipo: string;
  o_que: string;
  avisos?: string[];
  /** tabela criada (para checar se a RLS foi ligada no mesmo lote) */
  criou?: string;
  ligouRls?: string;
}

function acaoDeAlterTable(tabela: string, a: string): Achado {
  let m: RegExpExecArray | null;
  if ((m = RE.constraint.exec(a))) {
    return { tipo: 'ALTER TABLE ADD CONSTRAINT', o_que: `Acrescenta uma restrição${m[1] ? ` "${m[1]}"` : ''} (${m[2]}) na tabela ${tabela}` };
  }
  if (/^add constraint\b/.test(a)) return { tipo: 'ALTER TABLE ADD CONSTRAINT', o_que: `Acrescenta uma restrição na tabela ${tabela}` };
  if ((m = RE.coluna.exec(a))) {
    const avisos: string[] = [];
    if (/\bnot null\b/.test(m[3]!) && !/\bdefault\b|\bgenerated\b/.test(m[3]!)) {
      avisos.push(`a coluna ${m[2]} é NOT NULL sem DEFAULT: falha se a tabela ${tabela} já tiver linhas`);
    }
    return { tipo: 'ALTER TABLE ADD COLUMN', o_que: `Acrescenta a coluna ${m[2]} na tabela ${tabela}${m[1] ? ' (se ainda não existir)' : ''}`, avisos };
  }
  if ((m = RE.default.exec(a))) {
    return { tipo: 'ALTER COLUMN SET DEFAULT', o_que: `Muda o valor padrão da coluna ${m[1]} da tabela ${tabela} (só vale para linhas novas)` };
  }
  if ((m = RE.naoNulo.exec(a))) {
    return { tipo: 'ALTER COLUMN SET NOT NULL', o_que: `Torna a coluna ${m[1]} da tabela ${tabela} obrigatória`, avisos: [`SET NOT NULL falha se já houver linha com ${m[1]} vazio`] };
  }
  if ((m = RE.tipo.exec(a))) {
    return {
      tipo: 'ALTER COLUMN TYPE',
      o_que: `Muda o TIPO da coluna ${m[1]} da tabela ${tabela}`,
      avisos: [`mudar o tipo de ${tabela}.${m[1]} pode FALHAR se os dados que já existem não couberem no tipo novo (e reescreve a tabela inteira); se falhar nada muda`],
    };
  }
  if (a === 'enable row level security') return { tipo: 'ALTER TABLE ENABLE RLS', o_que: `Liga a segurança por linha (RLS) na tabela ${tabela}`, ligouRls: tabela };
  if (a === 'force row level security') return { tipo: 'ALTER TABLE FORCE RLS', o_que: `Faz a RLS valer também para o dono da tabela ${tabela}` };
  if (/^disable row level security|^no force row level security/.test(a)) {
    recusa(`desligar a segurança por linha (RLS) de ${tabela} não é permitido por aqui: ela é o que decide quem vê cada linha`);
  }
  if (/^(rename|owner to|set schema|set tablespace|inherit|no inherit|attach|detach)\b/.test(a)) {
    recusa(`"${a.split(' ').slice(0, 2).join(' ').toUpperCase()}" em ${tabela} não é permitido por aqui (renomear ou mudar de dono quebra quem lê o nome antigo): crie uma coluna nova com ADD COLUMN ou peça a quem administra o servidor`);
  }
  recusa(`não reconheço esta ação em ALTER TABLE ${tabela}: "${a.slice(0, 80)}". ${ACEITO}`);
}

/** A política precisa dizer PARA QUEM vale (authenticated e/ou service_role): sem TO ela valeria também para o público sem login. */
function politica(m: RegExpExecArray, cmd: string): Achado {
  const t = nomeDaApp(m[3]!, 'POLICY');
  const papeis = m[4]?.trim();
  if (m[1] === 'create' && !papeis) {
    recusa(`a política ${m[2]} precisa dizer para quem vale: acrescente "TO authenticated" (usuários logados) — sem isso ela valeria também para quem não fez login`);
  }
  if (papeis && !new RegExp(`^${LISTA_PAPEIS}$`).test(papeis)) recusa(`na política ${m[2]} use "TO authenticated" e/ou "TO service_role" (recebi "TO ${papeis.slice(0, 40)}")`);
  const avisos = /\b(using|with check)\s*\(\s*true\s*\)/.test(cmd) ? [`a política ${m[2]} usa (true): libera TODAS as linhas de ${t} para todo usuário logado`] : [];
  return { tipo: `${m[1]!.toUpperCase()} POLICY`, o_que: `${m[1] === 'create' ? 'Cria' : 'Altera'} a política ${m[2]} da tabela ${t} (regra de quem vê/grava cada linha)`, avisos };
}

function comentario(m: RegExpExecArray): Achado {
  const alvo = m[2]!;
  const partes = alvo.split('.');
  // column: [public.]tabela.coluna; os outros: [public.]nome (constraint e policy levam "nome on tabela")
  const alvoTabela = m[1] === 'constraint' || m[1] === 'policy' ? alvo.split(/\s+on\s+/)[1] : undefined;
  if (alvoTabela) nomeDaApp(alvoTabela, 'COMMENT');
  else if (m[1] === 'column') {
    if (partes.length === 3) nomeDaApp(`${partes[0]}.${partes[1]}`, 'COMMENT');
  } else nomeDaApp(alvo, 'COMMENT');
  return { tipo: 'COMMENT', o_que: `Escreve o comentário d${['column', 'view', 'policy'].includes(m[1]!) ? 'a' : 'o'} ${m[1]} ${alvo}` };
}

function achar(cmd: string): Achado[] {
  let m: RegExpExecArray | null;

  if (/^create (temp|temporary|global|local)\b/.test(cmd)) recusa('tabela ou objeto temporário não faz sentido por aqui (some quando a conexão fecha): crie a tabela de verdade');
  if (/^create materialized view\b/.test(cmd)) recusa('view materializada não é permitida por aqui (ela não respeita a segurança por linha): use CREATE VIEW ... WITH (security_invoker = true)');

  if ((m = RE.tabela.exec(cmd))) {
    const t = nomeDaApp(m[2]!, 'CREATE TABLE');
    return [{ tipo: 'CREATE TABLE', o_que: `Cria a tabela ${t}${m[1] ? ' (se ainda não existir)' : ''}`, criou: t }];
  }
  if (/^create (unique )?index concurrently\b/.test(cmd)) {
    recusa('CREATE INDEX CONCURRENTLY não funciona aqui (o servidor roda dentro de uma transação): use CREATE INDEX');
  }
  if ((m = RE.indice.exec(cmd))) {
    const t = nomeDaApp(m[3]!, 'CREATE INDEX');
    return [{ tipo: 'CREATE INDEX', o_que: `Cria o índice${m[1] ? ' ÚNICO' : ''}${m[2] ? ` ${m[2]}` : ''} na tabela ${t}` }];
  }
  if ((m = RE.view.exec(cmd))) {
    const v = nomeDaApp(m[2]!, 'CREATE VIEW');
    return [{ tipo: 'CREATE VIEW', o_que: `${m[1] ? 'Cria ou SUBSTITUI' : 'Cria'} a view ${v} (com as permissões de quem consulta)` }];
  }
  if ((m = RE.viewSemOpcao.exec(cmd))) {
    // a view roda com os direitos de quem a criou (que enxerga tudo); sem security_invoker ela PASSA POR CIMA da segurança por linha
    const v = nomeDaApp(m[2]!, 'CREATE VIEW');
    recusa(`a view ${v} precisa de WITH (security_invoker = true) logo depois do nome: sem isso ela ignora a segurança por linha e mostra a todos os usuários logados o que só alguns podem ver. Exemplo: CREATE VIEW ${v} WITH (security_invoker = true) AS SELECT ...`);
  }
  if ((m = RE.alterTable.exec(cmd))) {
    const t = nomeDaApp(m[1]!, 'ALTER TABLE');
    return partirPorVirgula(m[2]!).map((a) => acaoDeAlterTable(t, a));
  }
  if (/^alter policy \S+ on \S+ rename\b/.test(cmd)) recusa('renomear política não é permitido por aqui: crie a nova com CREATE POLICY');
  if ((m = RE.politica.exec(cmd))) return [politica(m, cmd)];
  if ((m = RE.comentario.exec(cmd))) return [comentario(m)];
  if ((m = RE.concede.exec(cmd))) {
    for (const o of m[3]!.split(',')) nomeDaApp(o.trim(), m[1]!.toUpperCase());
    const grant = m[1] === 'grant';
    const logados = /\bauthenticated\b/.test(m[4]!);
    return [
      {
        tipo: m[1]!.toUpperCase(),
        o_que: `${grant ? 'Dá' : 'Tira'} ${m[2]} em ${m[3]} ${grant ? 'a' : 'de'} ${m[4]}`,
        avisos: logados ? [`${grant ? 'GRANT' : 'REVOKE'} em ${m[3]} vale para TODOS os usuários logados (authenticated); quem vê cada linha é decidido pela RLS`] : [],
      },
    ];
  }
  if (/^(grant|revoke)\b/.test(cmd)) {
    recusa('GRANT/REVOKE só de SELECT, INSERT, UPDATE, DELETE ou USAGE, numa tabela ou sequência do esquema public, para authenticated e/ou service_role (sem "all", sem "public", sem papéis internos, sem "with grant option")');
  }
  recusa(`não reconheço este comando: "${cmd.slice(0, 80)}". ${ACEITO}`);
}

/**
 * Esquema que não é `public` em qualquer lugar do comando (FROM, REFERENCES, AS SELECT…), não só no objeto principal.
 * `x.y` com `x` que aparece em outro lugar do comando sem ponto é apelido de tabela (ex. `from caixa_precos p … p.id`), não esquema.
 */
function esquemaDeFora(cmd: string): string | undefined {
  if (/^comment on\b/.test(cmd)) return undefined; // o alvo do comentário é conferido em comentario()
  for (const m of cmd.matchAll(/(?<![.\w$])([a-z_][a-z0-9_$]*)\s*\.\s*(?=[a-z_*])/g)) {
    const q = m[1]!;
    if (q === 'public') continue;
    const sozinho = new RegExp(`(?<![.\\w$])${q.replace(/\$/g, '\\$')}(?![\\w$])(?!\\s*\\.)`);
    if (!sozinho.test(cmd)) return q;
  }
  return undefined;
}

/** Confere o SQL e devolve o que ele faz. Lança `ErroDeEntrada` com o que reescrever quando recusa. */
export function analisarEstrutura(sqlBruto: unknown): AnaliseEstrutura {
  if (typeof sqlBruto !== 'string' || !sqlBruto.trim()) recusa('sql vazio');
  const sql = sqlBruto.trim();
  if (sql.length > MAX_SQL) recusa(`sql grande demais (máximo ${MAX_SQL} caracteres): mande em partes`);

  // o servidor recusa estas palavras e estes esquemas até dentro de texto e comentário; avisar aqui evita a ida e volta
  // (e fecha o caminho de funções que recebem SQL em texto, como query_to_xml('select … from auth.users'))
  const cru = sql.toLowerCase();
  const apagar = /\b(drop|truncate|copy)\b/.exec(cru);
  if (apagar) {
    recusa(`DROP, TRUNCATE e COPY não existem por aqui (o servidor recusa a palavra "${apagar[1]!.toUpperCase()}" até dentro de texto ou comentário). Para remover algo, peça a quem administra o servidor; para trocar o valor padrão use ALTER COLUMN SET DEFAULT.`);
  }
  if (cru.includes('"')) recusa('não use aspas duplas (") em lugar nenhum: escreva os nomes de tabela e coluna em minúsculas, com letras, números e "_", e use aspas simples para texto');
  if (ESQUEMA_PROIBIDO.test(cru) || /\b(information_schema|pg_[a-z0-9_]+|[a-z_]*_to_xml[a-z_]*)\b/.test(cru)) {
    recusa('não mexa nem leia os esquemas auth, storage, pg_*, information_schema ou de extensões (nem por função que recebe SQL em texto): só o esquema public. Em política de acesso use as funções do próprio public (veja sistemas_esquema, funcoes), não auth.uid().');
  }

  const esq = esqueletoDoSql(sql).toLowerCase();
  const proibida = /\b(security\s+definer|set\s+role|reset\s+role|session\s+authorization|execute|lo_import|lo_export|dblink|set_config|anon)\b/.exec(esq);
  if (proibida) {
    recusa(`"${proibida[1]!.replace(/\s+/g, ' ').toUpperCase()}" não é permitido por aqui${proibida[1] === 'anon' ? ' (anon é o acesso SEM login: nada fica aberto a ele)' : ''}`);
  }

  const pedacos = esq.split(';').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!pedacos.length) recusa('sql vazio (só comentário?)');
  if (pedacos.length > MAX_COMANDOS) recusa(`comandos demais (${pedacos.length}; máximo ${MAX_COMANDOS}): mande em partes`);

  const achados = pedacos.flatMap((p) => {
    const fora = esquemaDeFora(p);
    if (fora) recusa(`só o esquema "public" é permitido: "${fora}." aparece num comando (FROM, REFERENCES…). Escreva public.<tabela> ou só a tabela.`);
    return achar(p);
  });
  const avisos = achados.flatMap((a) => a.avisos ?? []);
  const comRls = new Set(achados.flatMap((a) => (a.ligouRls ? [a.ligouRls] : [])));
  for (const a of achados) {
    if (a.criou && !comRls.has(a.criou)) {
      avisos.push(`a tabela ${a.criou} nasce SEM segurança por linha: todo usuário logado lê e grava todas as linhas dela. Junte neste mesmo pedido ALTER TABLE ${a.criou} ENABLE ROW LEVEL SECURITY e as CREATE POLICY, ou faça logo em seguida.`);
    }
  }
  return { sql, comandos: achados.map((a, i) => ({ n: i + 1, tipo: a.tipo, o_que: a.o_que })), avisos: [...new Set(avisos)] };
}

// ------------------------------------------------------------------ os dois passos

const MOTIVO = z.string().min(5).max(300).describe('por que — fica no registro (ex.: "tabela de preços do caixa")');

function motivoValido(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : '';
  if (m.length < 5) recusa('diga o motivo em uma frase (mínimo 5 caracteres): ele fica no registro');
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
        'Nomes em minúsculas, sem aspas, no esquema public; uma tabela nova precisa de ENABLE ROW LEVEL SECURITY e política. Mostre o resumo e o SQL à ' +
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
