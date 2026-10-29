/**
 * O sistema novo de RH/Caixa/Financeiro (servidor próprio, saiu do Supabase) pelo claude.ai — a ferramenta da Lia.
 * Fala com a API de administração `/admin/v1` (contrato: docs/ADMIN-API.md do repositório sistemas-dd); a URL base e a
 * chave (ADMIN_KEY) vêm do painel de integrações (provedor `sistemas`) e NUNCA saem numa resposta nem numa mensagem de erro.
 *
 * LEITURA (qualquer pessoa com acesso ao conector): `sistemas_esquema`, `sistemas_consultar` (um SELECT), `sistemas_usuarios`,
 * `sistemas_log`, `sistemas_simular` (auditoria: o que um usuário enxerga/consegue fazer; o modo escrever é sempre desfeito).
 * ESCRITA (só quem está em MCP_ESCRITA_EMAILS, como o Kommo): em DOIS passos, `sistemas_preparar_alteracao` mostra o que vai
 * mudar (antes → depois) e devolve um código; `sistemas_confirmar_alteracao` com o código grava. Mais `sistemas_usuario`
 * (papel, unidade, ativo) e `sistemas_convite` (link de acesso, sem senha).
 *
 * Quem pediu (`quem`) é o e-mail de quem entrou no conector: o servidor o grava no registro de alterações.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';

/** O que as ferramentas precisam do servidor. Em produção, `sistemasChamar` com a chave; nos testes, um servidor falso. */
export interface FonteSistemas {
  chamar(metodo: 'GET' | 'POST', caminho: string, o?: { corpo?: unknown; query?: Record<string, string | number | undefined>; quem?: string; timeoutMs?: number }): Promise<unknown>;
}

export interface ContaSistemas {
  slug: string;
  nome: string;
  fonte: FonteSistemas;
  /** endereço da tela RH, para montar o link de convite */
  tela?: string;
}

export interface ContextoSistemas {
  contas: Map<string, ContaSistemas>;
}

export function criarContextoSistemas(contas: Map<string, ContaSistemas> = new Map()): ContextoSistemas {
  return { contas };
}

/** Quem está no conector: `usuario` (id do console) prende o código de confirmação; `nome` (e-mail) vai para o registro do servidor. */
export interface QuemSistemas {
  usuario: string;
  nome: string;
}

export const VALIDADE_MS = 10 * 60_000;
/** acima disso a resposta de `sistemas_consultar` é cortada (o servidor já limita a 1.000 linhas) */
export const MAX_CARACTERES = 200_000;

const SEM_INTEGRACAO = 'o sistema novo (RH/Caixa) ainda não está ligado neste conector: cadastre a URL e a chave no painel de integrações (/api/integracoes/painel, coluna "Sistemas (RH/Caixa)").';

export function resolverSistema(ctx: ContextoSistemas, pedido?: string): ContaSistemas {
  if (ctx.contas.size === 0) throw new ErroDeEntrada(SEM_INTEGRACAO);
  if (!pedido?.trim()) {
    if (ctx.contas.size === 1) return [...ctx.contas.values()][0]!;
    throw new ErroDeEntrada(`informe o sistema. Ligados: ${[...ctx.contas.keys()].join(', ')}`);
  }
  const slug = acharSlug(ctx.contas.keys(), pedido);
  if (!slug) throw new ErroDeEntrada(`sistema "${pedido}" não está ligado ou é ambíguo. Ligados: ${[...ctx.contas.keys()].join(', ')}`);
  return ctx.contas.get(slug)!;
}

// ------------------------------------------------------------------ validação do SQL

/**
 * Tira do SQL o que não é comando: textos entre aspas simples, identificadores entre aspas duplas, comentários e
 * blocos $$…$$. Sobra o esqueleto, onde se procura `;` e palavras de escrita. NÃO substitui o servidor (ele roda como
 * papel só-leitura, em transação READ ONLY): só barra o óbvio com mensagem clara.
 */
export function esqueletoDoSql(sql: string): string {
  return varrerSql(sql).esqueleto;
}

const CARACTERE_DE_NOME = /[A-Za-z0-9_$]/;

/** O esqueleto e a posição, no texto original, de cada `;` que está fora de texto e comentário. */
function varrerSql(sql: string): { esqueleto: string; pontosEVirgula: number[] } {
  let out = '';
  const pontos: number[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const prox = sql[i + 1];
    const antes = sql[i - 1];
    if (c === "'" || c === '"') {
      // E'...' aceita \ como escape (\' não fecha o texto); a aspa dupla e o texto comum não
      const comEscape = c === "'" && (antes === 'e' || antes === 'E') && !(sql[i - 2] && CARACTERE_DE_NOME.test(sql[i - 2]!));
      i++;
      while (i < sql.length) {
        if (comEscape && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      out += ' ';
    } else if (c === '-' && prox === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && prox === '*') {
      let nivel = 1;
      i += 2;
      while (i < sql.length && nivel > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { nivel++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { nivel--; i += 2; } else i++;
      }
      out += ' ';
    } else if (c === '$' && !(antes && CARACTERE_DE_NOME.test(antes))) {
      // $$ ... $$ e $tag$ ... $tag$ — mas `a$$` é um nome (o `$` é letra de nome no Postgres)
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const fim = sql.indexOf(tag, i + tag.length);
        i = fim < 0 ? sql.length : fim + tag.length;
        out += ' ';
      } else {
        out += c;
        i++;
      }
    } else {
      if (c === ';') pontos.push(i);
      out += c;
      i++;
    }
  }
  return { esqueleto: out, pontosEVirgula: pontos };
}

const ESCRITA_NO_SQL = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|merge|call|execute)\b/i;
/** Um único comando: devolve o SQL sem o `;` final. */
function umComando(sql: unknown, estrito = false): { sql: string; esqueleto: string } {
  if (typeof sql !== 'string' || !sql.trim()) throw new ErroDeEntrada('sql vazio');
  let texto = sql.trim();
  if (texto.length > 20_000) throw new ErroDeEntrada('sql grande demais (máximo 20.000 caracteres)');
  const { esqueleto, pontosEVirgula } = varrerSql(texto);
  let esq = esqueleto.trim();
  const ultimo = pontosEVirgula.at(-1);
  // um ";" só e no fim (depois dele só espaço ou comentário): sai do texto enviado
  if (pontosEVirgula.length === 1 && esq.endsWith(';') && ultimo !== undefined) {
    texto = (texto.slice(0, ultimo) + texto.slice(ultimo + 1)).trim();
    esq = esq.slice(0, -1).trim();
  }
  if (esq.includes(';')) throw new ErroDeEntrada('mande um comando só: tem mais de um separado por ";"');
  // quando o comando vai ser EXECUTADO (simulação que escreve), dúvida é recusa: nenhum ";" escondido em texto
  if (estrito && texto.includes(';')) throw new ErroDeEntrada('na simulação que escreve não use ";" nem dentro de texto: mande um comando só');
  return { sql: texto, esqueleto: esq };
}

/** Só SELECT (ou WITH … SELECT). Qualquer palavra de escrita fora de texto entre aspas é recusada. */
export function validarSelect(sql: unknown): string {
  const { sql: texto, esqueleto } = umComando(sql);
  if (!/^\(*\s*(select|with)\b/i.test(esqueleto)) throw new ErroDeEntrada('só é permitido um SELECT (ou WITH … SELECT); para alterar dados use sistemas_preparar_alteracao');
  const achou = ESCRITA_NO_SQL.exec(esqueleto);
  if (achou) throw new ErroDeEntrada(`a consulta é só leitura e tem a palavra "${achou[1]!.toUpperCase()}": para alterar dados use sistemas_preparar_alteracao`);
  return texto;
}

/** Para a simulação em modo escrever: um comando de dados (o servidor desfaz). Um comando só, sem ";" em lugar nenhum, e só esses verbos (nada de BEGIN/COMMIT/SET/DDL). */
export function validarComandoDeDados(sql: unknown): string {
  const { sql: texto, esqueleto } = umComando(sql, true);
  if (!/^\(*\s*(select|with|insert|update|delete)\b/i.test(esqueleto)) {
    throw new ErroDeEntrada('na simulação use um SELECT, INSERT, UPDATE ou DELETE (um comando só)');
  }
  return texto;
}

// ------------------------------------------------------------------ entrada

const NOME_SQL = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ID_USUARIO = /^[\w-]{1,64}$/;

function nomeSql(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !NOME_SQL.test(v)) throw new ErroDeEntrada(`${campo}: use só letras, números e "_" (recebi ${JSON.stringify(String(v).slice(0, 40))})`);
  return v;
}

function idUsuario(v: unknown): string {
  if (typeof v !== 'string' || !ID_USUARIO.test(v)) throw new ErroDeEntrada('user_id inválido: use o identificador que sistemas_usuarios devolve');
  return v;
}

// o corpo do servidor passa adiante como veio (o contrato é dele): por isso `any`, e quem lê confere cada campo
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Saida = Record<string, any>;
const resposta = (r: unknown): Saida => (r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : { resposta: r });

// ------------------------------------------------------------------ leitura

export async function esquema(ctx: ContextoSistemas, a: { sistema?: string; tabela?: string; incluirFuncoes?: boolean }) {
  const c = resolverSistema(ctx, a.sistema);
  const r = resposta(await c.fonte.chamar('GET', '/admin/v1/esquema'));
  const busca = a.tabela?.trim().toLowerCase();
  if (!busca) return { sistema: c.slug, ...r };
  const tabelas = (Array.isArray(r.tabelas) ? r.tabelas : []).filter((t) => String((t as { nome?: unknown }).nome ?? '').toLowerCase().includes(busca));
  const checks = (Array.isArray(r.checks) ? r.checks : []).filter((k) => String((k as { tabela?: unknown }).tabela ?? '').toLowerCase().includes(busca));
  return { sistema: c.slug, tabelas, checks, ...(a.incluirFuncoes ? { funcoes: r.funcoes } : {}), filtro: `tabelas com "${busca}" no nome` };
}

export async function consultar(ctx: ContextoSistemas, quem: string, a: { sistema?: string; sql: string }) {
  const sql = validarSelect(a.sql);
  const c = resolverSistema(ctx, a.sistema);
  const r = resposta(await c.fonte.chamar('POST', '/admin/v1/consulta', { corpo: { sql }, quem }));
  const linhas = Array.isArray(r.linhas) ? r.linhas : [];
  let cortado = r.cortado === true;
  let devolvidas = linhas;
  // resposta enorme não cabe no contexto de quem pergunta: corta e avisa, em vez de afogar a conversa
  if (JSON.stringify(linhas).length > MAX_CARACTERES) {
    let n = linhas.length;
    while (n > 1 && JSON.stringify(linhas.slice(0, n)).length > MAX_CARACTERES) n = Math.floor(n / 2);
    devolvidas = linhas.slice(0, n);
    cortado = true;
  }
  return {
    sistema: c.slug,
    colunas: r.colunas ?? [],
    linhas: devolvidas,
    linhasDevolvidas: devolvidas.length,
    cortado,
    ...(cortado ? { aviso: 'o resultado foi cortado (limite de linhas ou de tamanho): refine com WHERE, LIMIT ou colunas específicas' } : {}),
  };
}

export async function usuarios(ctx: ContextoSistemas, quem: string, a: { sistema?: string }) {
  const c = resolverSistema(ctx, a.sistema);
  return { sistema: c.slug, ...resposta(await c.fonte.chamar('GET', '/admin/v1/usuarios', { quem })) };
}

function dataValida(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (!m) return false;
  const [ano, mes, dia, h = 0, mi = 0, se = 0] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const d = new Date(Date.UTC(ano!, mes! - 1, dia!));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes! - 1 && d.getUTCDate() === dia && h! < 24 && mi! < 60 && se! < 60;
}

export async function log(ctx: ContextoSistemas, quem: string, a: { sistema?: string; tabela?: string; desde?: string; limite?: number }) {
  const c = resolverSistema(ctx, a.sistema);
  const tabela = a.tabela ? nomeSql(a.tabela, 'tabela') : undefined;
  if (a.desde && !dataValida(a.desde)) throw new ErroDeEntrada(`desde: use AAAA-MM-DD ou AAAA-MM-DD HH:MM (recebi "${a.desde.slice(0, 30)}")`);
  const limite = a.limite === undefined ? 100 : Math.min(Math.max(Math.trunc(a.limite), 1), 500);
  return { sistema: c.slug, ...resposta(await c.fonte.chamar('GET', '/admin/v1/log', { quem, query: { tabela, desde: a.desde, limite } })) };
}

export async function simular(ctx: ContextoSistemas, quem: string, a: { sistema?: string; usuario: string; sql: string; escrever?: boolean }) {
  const escrever = a.escrever === true;
  const sql = escrever ? validarComandoDeDados(a.sql) : validarSelect(a.sql);
  const user_id = idUsuario(a.usuario);
  const c = resolverSistema(ctx, a.sistema);
  const r = resposta(await c.fonte.chamar('POST', '/admin/v1/simular', { corpo: { user_id, sql, escrever }, quem }));
  return {
    sistema: c.slug,
    modo: escrever ? 'escrever (executado e DESFEITO: nada foi gravado)' : 'leitura',
    ...r,
  };
}

// ------------------------------------------------------------------ escrita

interface Pendente {
  usuario: string;
  sistema: string;
  criadoEm: number;
  operacao: string;
  tabela: string;
}

/** Códigos preparados à espera da confirmação, presos a quem preparou. Em memória: reinício = preparar de novo. */
export class PendentesSistemas {
  private itens = new Map<string, Pendente>();
  constructor(private agora: () => number = Date.now) {}
  guardar(id: string, p: Omit<Pendente, 'criadoEm'>): string {
    for (const [k, v] of this.itens) if (this.agora() - v.criadoEm > VALIDADE_MS) this.itens.delete(k);
    const criadoEm = this.agora();
    this.itens.set(id, { ...p, criadoEm });
    return new Date(criadoEm + VALIDADE_MS).toISOString();
  }
  /** Resultado incerto (rede caiu na confirmação): o código volta, para a pessoa tentar de novo depois de conferir o registro. */
  devolver(id: string, p: Pendente): void {
    this.itens.set(id, p);
  }
  tirar(id: string, usuario: string): Pendente {
    const p = this.itens.get(id);
    if (!p) throw new ErroDeEntrada('código de confirmação desconhecido ou já usado (ou o conector reiniciou desde a prévia): prepare a alteração de novo');
    if (p.usuario !== usuario) throw new ErroDeEntrada('este código foi gerado por outro usuário');
    this.itens.delete(id);
    if (this.agora() - p.criadoEm > VALIDADE_MS) throw new ErroDeEntrada('o código venceu (10 minutos): prepare a alteração de novo');
    return p;
  }
}

export type Operacao = 'inserir' | 'atualizar' | 'apagar';
const escalar = z.union([z.string(), z.number(), z.boolean()]);

export async function prepararAlteracao(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { sistema?: string; operacao: Operacao; tabela: string; filtro?: Record<string, string | number | boolean>; dados?: Record<string, unknown> },
): Promise<Saida> {
  if (!['inserir', 'atualizar', 'apagar'].includes(a.operacao)) throw new ErroDeEntrada('operacao: use inserir, atualizar ou apagar');
  const tabela = nomeSql(a.tabela, 'tabela');
  const filtro = a.filtro ?? {};
  const dados = a.dados ?? {};
  for (const col of [...Object.keys(filtro), ...Object.keys(dados)]) nomeSql(col, `coluna "${col.slice(0, 40)}"`);
  if (Object.keys(dados).length > 80 || JSON.stringify(dados).length > 100_000) throw new ErroDeEntrada('dados grandes demais para uma alteração');
  if (a.operacao === 'inserir' && !Object.keys(dados).length) throw new ErroDeEntrada('inserir precisa de "dados"');
  if (a.operacao === 'atualizar' && !Object.keys(dados).length) throw new ErroDeEntrada('atualizar precisa de "dados" (as colunas novas)');
  if (a.operacao !== 'inserir' && !Object.keys(filtro).length) throw new ErroDeEntrada(`${a.operacao} precisa de "filtro" (coluna = valor): não mexo na tabela inteira`);
  if (a.operacao === 'apagar' && Object.keys(dados).length) throw new ErroDeEntrada('apagar não leva "dados"');
  if (tabela.toLowerCase() === 'rh_usuarios') throw new ErroDeEntrada('rh_usuarios só muda por sistemas_usuario (papel, unidade, ativo)');
  const c = resolverSistema(ctx, a.sistema);
  const r = resposta(
    await c.fonte.chamar('POST', '/admin/v1/preparar', {
      corpo: { op: a.operacao, tabela, ...(Object.keys(filtro).length ? { filtro } : {}), ...(a.operacao === 'apagar' ? {} : { dados }), quem: quem.nome },
      quem: quem.nome,
    }),
  );
  const { id, ...resto } = r;
  if (typeof id !== 'string' || !id) throw new ErroDeEntrada('o servidor não devolveu o código da prévia: nada foi preparado');
  const expiraEm = pendentes.guardar(id, { usuario: quem.usuario, sistema: c.slug, operacao: a.operacao, tabela });
  return {
    sistema: c.slug,
    operacao: a.operacao,
    tabela,
    ...resto,
    confirmacao: id,
    expiraEm,
    instrucao: `Nada foi gravado ainda. Mostre o resumo (e o antes → depois) à pessoa e, se ela aprovar, chame sistemas_confirmar_alteracao com confirmacao="${id}" (vale 10 minutos).`,
  };
}

export async function confirmarAlteracao(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { confirmacao: string },
): Promise<Saida> {
  const p = pendentes.tirar(String(a.confirmacao ?? '').trim(), quem.usuario);
  const c = resolverSistema(ctx, p.sistema);
  const id = String(a.confirmacao).trim();
  let r: Saida;
  try {
    r = resposta(await c.fonte.chamar('POST', '/admin/v1/confirmar', { corpo: { id, quem: quem.nome }, quem: quem.nome, timeoutMs: 60_000 }));
  } catch (e) {
    // sem resposta (rede, tempo esgotado) ou erro do servidor: pode ter gravado. O código volta e a pessoa confere antes de repetir.
    if (e instanceof ErroSistemas && (e.status === null || e.status >= 500)) {
      pendentes.devolver(id, p);
      throw new ErroDeEntrada(`NÃO sei se a alteração foi gravada (${e.message}). Confira com sistemas_log e sistemas_consultar antes de repetir; o código ${id} continua valendo para tentar confirmar de novo (o servidor aplica cada código uma vez só).`);
    }
    throw e;
  }
  return {
    sistema: c.slug,
    operacao: p.operacao,
    tabela: p.tabela,
    ...r,
    ...(r.conferido === false
      ? { atencao: 'a releitura depois de gravar NÃO bateu com o esperado: confira com sistemas_consultar e sistemas_log; o "antes" está guardado (backup_id) e dá para desfazer pelo servidor.' }
      : {}),
    registro: 'A alteração ficou no registro do sistema (sistemas_log) com quem pediu, o antes e o depois.',
  };
}

export async function alterarUsuario(
  ctx: ContextoSistemas,
  quem: QuemSistemas,
  a: { sistema?: string; acao: 'papel' | 'unidade' | 'ativo'; usuario: string; valor: string | boolean },
): Promise<Saida> {
  if (!['papel', 'unidade', 'ativo'].includes(a.acao)) throw new ErroDeEntrada('acao: use papel, unidade ou ativo');
  const user_id = idUsuario(a.usuario);
  let valor: string | boolean = a.valor;
  if (a.acao === 'ativo') {
    if (typeof valor === 'string') {
      if (/^(sim|true|1|ativo|ativar)$/i.test(valor.trim())) valor = true;
      else if (/^(n[aã]o|false|0|inativo|desativar)$/i.test(valor.trim())) valor = false;
      else throw new ErroDeEntrada('para "ativo" o valor é sim ou não');
    }
  } else if (typeof valor !== 'string' || !valor.trim()) {
    throw new ErroDeEntrada(`para "${a.acao}" o valor é o texto novo (papel: admin, gestao, financeiro, unidade ou socio; unidade: a sigla da unidade)`);
  } else valor = valor.trim();
  const c = resolverSistema(ctx, a.sistema);
  return { sistema: c.slug, ...resposta(await c.fonte.chamar('POST', '/admin/v1/usuario', { corpo: { acao: a.acao, user_id, valor, quem: quem.nome }, quem: quem.nome })) };
}

/** Junta a tela RH com o caminho "#a-<token>" do servidor. */
export function linkDoConvite(tela: string, caminho: string): string {
  if (!/^#a-[A-Za-z0-9_-]{8,}$/.test(caminho)) throw new ErroDeEntrada('o servidor devolveu um caminho de convite em formato inesperado');
  const u = new URL(tela);
  u.hash = caminho;
  return u.toString();
}

export async function criarConvite(
  ctx: ContextoSistemas,
  quem: QuemSistemas,
  a: { sistema?: string; nome: string; login: string; papel: string; unidade?: string },
) {
  const c = resolverSistema(ctx, a.sistema);
  if (!c.tela) throw new ErroDeEntrada('falta o endereço da tela RH na configuração do sistema: cadastre de novo no painel de integrações, com o campo "tela"');
  if (!a.nome?.trim() || !a.login?.trim() || !a.papel?.trim()) throw new ErroDeEntrada('convite precisa de nome, login e papel');
  const r = resposta(
    await c.fonte.chamar('POST', '/admin/v1/convite', {
      corpo: { nome: a.nome.trim(), login: a.login.trim(), papel: a.papel.trim(), ...(a.unidade?.trim() ? { unidade: a.unidade.trim() } : {}), quem: quem.nome },
      quem: quem.nome,
    }),
  );
  if (typeof r.caminho !== 'string') throw new ErroDeEntrada('o servidor não devolveu o caminho do convite: nenhum link foi gerado');
  return {
    sistema: c.slug,
    ok: r.ok ?? true,
    link: linkDoConvite(c.tela, r.caminho),
    validade: '7 dias',
    aviso: 'Quem receber o link escolhe a própria senha. Envie só para a pessoa convidada; ninguém precisa de senha por aqui.',
  };
}

// ------------------------------------------------------------------ registro das ferramentas

/**
 * O registro de auditoria do conector guarda os argumentos de cada chamada, com outra retenção e outro público que o
 * sistema de RH. Aqui os valores dos dados (salário, CPF, nome do convidado…) ficam de fora: guarda-se QUEM mexeu em
 * QUAL tabela e COLUNAS; o antes e o depois ficam no registro do próprio sistema (sistemas_log).
 */
export function auditarSemDados(auditar: Auditar): Auditar {
  return (r) => {
    const a = (r.argumentos ?? {}) as Record<string, unknown>;
    const chaves = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v as object) : []);
    let argumentos: unknown = r.argumentos;
    if (r.ferramenta === 'sistemas_preparar_alteracao') {
      argumentos = { sistema: a.sistema, operacao: a.operacao, tabela: a.tabela, colunasDoFiltro: chaves(a.filtro), colunasDosDados: chaves(a.dados) };
    } else if (r.ferramenta === 'sistemas_convite') {
      argumentos = { sistema: a.sistema, papel: a.papel, unidade: a.unidade };
    } else if (r.ferramenta === 'sistemas_consultar' || r.ferramenta === 'sistemas_simular') {
      argumentos = { ...a, sql: String(a.sql ?? '').slice(0, 2000) };
    }
    auditar({ ...r, argumentos });
  };
}

const SISTEMA = z.string().optional().describe('qual sistema (slug da unidade onde está cadastrado); pode omitir se só há um ligado');

export function registrarLeituraSistemas(server: McpServer, ctx: ContextoSistemas, quem: QuemSistemas, auditarBruto: Auditar): void {
  const auditar = auditarSemDados(auditarBruto);
  const ro = { readOnlyHint: true, openWorldHint: false };
  server.registerTool(
    'sistemas_esquema',
    {
      title: 'Sistema novo (RH/Caixa): esquema do banco',
      description:
        'O mapa do banco do sistema novo de RH, Caixa e Financeiro: tabelas (com número de linhas), colunas e tipos, se a tabela tem RLS ' +
        'e quais políticas, funções do banco e restrições (checks). Comece por aqui antes de montar uma consulta. Use "tabela" para ver só ' +
        'as tabelas cujo nome contém o texto (ex.: "caixa"). Só leitura.',
      inputSchema: { sistema: SISTEMA, tabela: z.string().max(60).optional().describe('filtra pelo nome da tabela'), incluirFuncoes: z.boolean().optional().describe('com "tabela", inclui também as funções do banco (padrão: não)') },
      annotations: ro,
    },
    (args) => executar('sistemas_esquema', args, auditar, () => esquema(ctx, args)),
  );
  server.registerTool(
    'sistemas_consultar',
    {
      title: 'Sistema novo (RH/Caixa): consulta SELECT',
      description:
        'Roda UM SELECT (ou WITH … SELECT) no banco do sistema novo, só no schema public, com um papel só de leitura: sem hash de senha, sem ' +
        'dados de autenticação; máximo 1.000 linhas e 10 s. Um comando só, sem ";" no meio. Os dados de RH são sensíveis (CPF, salário, ' +
        'dados bancários): peça só as colunas de que precisa. Para alterar dados use sistemas_preparar_alteracao.',
      inputSchema: { sistema: SISTEMA, sql: z.string().min(6).max(20_000).describe('um SELECT, ex.: select unidade, sum(valor) from caixa_lancamentos group by 1') },
      annotations: ro,
    },
    (args) => executar('sistemas_consultar', args, auditar, () => consultar(ctx, quem.nome, args)),
  );
  server.registerTool(
    'sistemas_usuarios',
    {
      title: 'Sistema novo (RH/Caixa): usuários e papéis',
      description: 'Lista quem tem acesso ao sistema novo: identificador, login, nome, papel (admin, gestao, financeiro, unidade, socio), unidade, se está ativo e quando foi criado. O identificador (user_id) é o que sistemas_simular, sistemas_usuario e as demais ferramentas pedem.',
      inputSchema: { sistema: SISTEMA },
      annotations: ro,
    },
    (args) => executar('sistemas_usuarios', args, auditar, () => usuarios(ctx, quem.nome, args)),
  );
  server.registerTool(
    'sistemas_log',
    {
      title: 'Sistema novo (RH/Caixa): registro de alterações',
      description: 'O registro de alterações do sistema novo de RH (quem mudou, quando, em qual tabela, o antes e o depois). Filtre por "tabela" e por "desde" (AAAA-MM-DD). Padrão: 100 registros, máximo 500. Só o sistema de RH tem esse registro.',
      inputSchema: {
        sistema: SISTEMA,
        tabela: z.string().max(63).optional(),
        desde: z.string().max(25).optional().describe('AAAA-MM-DD ou AAAA-MM-DD HH:MM'),
        limite: z.number().int().min(1).max(500).optional(),
      },
      annotations: ro,
    },
    (args) => executar('sistemas_log', args, auditar, () => log(ctx, quem.nome, args)),
  );
  server.registerTool(
    'sistemas_simular',
    {
      title: 'Sistema novo (RH/Caixa): simular um usuário (auditoria)',
      description:
        'AUDITORIA de acesso: roda um comando COMO um usuário do sistema (do jeito que o app o enxerga, com as regras de RLS) e diz o que ele ' +
        'enxerga ou consegue fazer. Padrão: um SELECT, para ver o que o perfil lê. Com escrever=true o comando (INSERT, UPDATE ou DELETE) é ' +
        'executado e DESFEITO no fim — nada fica gravado; serve para provar que um perfil NÃO consegue apagar ou gravar. Um comando só. ' +
        'Identifique o usuário pelo user_id de sistemas_usuarios.',
      inputSchema: {
        sistema: SISTEMA,
        usuario: z.string().min(1).max(64).describe('user_id do usuário a simular (de sistemas_usuarios)'),
        sql: z.string().min(6).max(20_000),
        escrever: z.boolean().optional().describe('true = executa o comando e desfaz (rollback); padrão false = leitura'),
      },
      // com escrever=true o comando de gravação RODA (e é desfeito): não pode ser anunciada como só leitura, senão o cliente a aprova sozinho
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_simular', args, auditar, () => simular(ctx, quem.nome, args)),
  );
}

export function registrarEscritaSistemas(
  server: McpServer,
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  auditarBruto: Auditar,
): void {
  const auditar = auditarSemDados(auditarBruto);
  server.registerTool(
    'sistemas_preparar_alteracao',
    {
      title: 'Sistema novo (RH/Caixa): preparar alteração',
      description:
        'PASSO 1 de 2 para ALTERAR dados do sistema novo: inserir, atualizar ou apagar linhas de UMA tabela. NÃO grava nada: o servidor resolve o ' +
        'filtro (igualdade, até 500 linhas) e devolve o resumo, quantas linhas mudam e o antes → depois (até 20 linhas). Mostre isso à pessoa e ' +
        'só chame sistemas_confirmar_alteracao se ela aprovar. "filtro" é {coluna: valor} (obrigatório em atualizar e apagar); "dados" são as ' +
        'colunas novas. Apagar não vale em rh_docs, fin_* e caixa_*; rh_usuarios só muda por sistemas_usuario.',
      inputSchema: {
        sistema: SISTEMA,
        operacao: z.enum(['inserir', 'atualizar', 'apagar']),
        tabela: z.string().min(1).max(63),
        filtro: z.record(z.string(), escalar).optional().describe('{ "coluna": valor } — igualdade; as linhas afetadas'),
        dados: z.record(z.string(), z.unknown()).optional().describe('{ "coluna": novo valor } — em inserir, a linha toda'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_preparar_alteracao', args, auditar, () => prepararAlteracao(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_confirmar_alteracao',
    {
      title: 'Sistema novo (RH/Caixa): confirmar alteração',
      description:
        'PASSO 2 de 2: grava a alteração preparada, com o código que sistemas_preparar_alteracao devolveu. Só chame depois que a pessoa aprovou ' +
        'o resumo. O código vale 10 minutos e uma vez, e só para quem preparou. O servidor guarda o "antes" (dá para desfazer), grava, relê e ' +
        'confere; se "conferido" vier false, avise a pessoa.',
      inputSchema: { confirmacao: z.string().min(4).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => executar('sistemas_confirmar_alteracao', args, auditar, () => confirmarAlteracao(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_usuario',
    {
      title: 'Sistema novo (RH/Caixa): mudar papel, unidade ou ativo de um usuário',
      description:
        'Muda UMA coisa de um usuário do sistema novo, direto (sem prévia — é pequeno e reversível): acao="papel" (admin, gestao, financeiro, unidade ' +
        'ou socio), acao="unidade" (unidade que existe no cadastro; obrigatória para os papéis unidade e socio) ou acao="ativo" (sim/não). ' +
        'ANTES de chamar, diga à pessoa quem muda e de quê para quê, e só chame com o ok dela. Devolve o antes e o depois. user_id vem de sistemas_usuarios.',
      inputSchema: {
        sistema: SISTEMA,
        acao: z.enum(['papel', 'unidade', 'ativo']),
        usuario: z.string().min(1).max(64).describe('user_id (de sistemas_usuarios)'),
        valor: z.union([z.string(), z.boolean()]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_usuario', args, auditar, () => alterarUsuario(ctx, quem, args)),
  );
  server.registerTool(
    'sistemas_convite',
    {
      title: 'Sistema novo (RH/Caixa): criar convite de acesso',
      description:
        'Cria um convite de acesso ao sistema novo e devolve o LINK COMPLETO (vale 7 dias). Não há senha: quem recebe o link escolhe a própria. ' +
        'Informe nome, login e papel (admin, gestao, financeiro, unidade ou socio); unidade é obrigatória para unidade e socio. ' +
        'Confirme os dados com a pessoa antes de chamar, e entregue o link só à pessoa convidada.',
      inputSchema: {
        sistema: SISTEMA,
        nome: z.string().min(1).max(120),
        login: z.string().min(1).max(120),
        papel: z.string().min(1).max(30),
        unidade: z.string().max(60).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => executar('sistemas_convite', args, auditar, () => criarConvite(ctx, quem, args)),
  );
}
