/**
 * BANCO DE DADOS pelo claude.ai (`banco_*`), só para quem está em MCP_BANCO_EMAILS (a Suzanne e quem o João puser) — pedido de 11/11/2026.
 *
 * Bancos: `agente` (o do próprio agente-dt, por SQL direto), `rh` (RH/Caixa/Financeiro) e `dsc` (Descontratos/Ficha). Os dois últimos são
 * lidos pela API de administração do sistema (a mesma do `sistemas_consultar`, com a chave do painel de integrações): o agente não tem
 * senha do banco deles. O n8n não entra (não há credencial).
 *
 * LEITURA: só SELECT/WITH, em transação READ ONLY, com `statement_timeout` de 30 s, no máximo 500 linhas e 200 KB de resposta.
 * ESCRITA (só `agente`): INSERT/UPDATE/DELETE simples em DOIS passos — `banco_preparar_escrita` roda o comando numa transação e DESFAZ
 * (mostra quantas linhas e o antes → depois), `banco_confirmar_escrita` grava, guarda o backup das linhas em `mcp_banco_alteracoes`
 * (na MESMA transação: sem backup não há escrita), e avisa o João no Telegram. `banco_preparar_desfazer` devolve as linhas do backup.
 * Teto de 200 linhas por escrita. DDL e vários comandos num só não existem. No RH/Descontratos a escrita segue por `sistemas_preparar_alteracao`.
 *
 * Segredos (cofre de chaves, tokens, sessões, OAuth, senhas, hashes): tabelas e colunas fechadas para leitura E escrita (banco-segredos.ts).
 * O parser e as travas estão em banco-sql.ts; o acesso ao banco, em banco-pg.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { colunaSecreta, tabelaSecreta, TABELAS_SO_LEITURA } from './banco-segredos.js';
import {
  analisarEscrita,
  analisarLeitura,
  colunasBoas,
  colunasOcultas,
  MAX_BYTES_LINHA,
  MAX_BYTES_RESPOSTA,
  MAX_LINHAS_ESCRITA,
  MAX_LINHAS_LEITURA,
  montarLeitura,
  sqlAntes,
  sqlApagarPorChave,
  sqlExecutar,
  sqlPorChave,
  sqlReinserir,
  sqlRestaurarLinha,
  tabelaFechada,
  type Catalogo,
  type PlanoEscrita,
  type TabelaCat,
} from './banco-sql.js';
import { executar } from './ferramenta.js';

export type BancoId = 'agente' | 'rh' | 'dsc';
export const BANCOS: Record<BancoId, string> = {
  agente: 'banco do próprio agente-dt (unidades, conversas, Sofia, auditoria do conector…)',
  rh: 'RH/Caixa/Financeiro (sistema novo)',
  dsc: 'Descontratos/Ficha',
};
export const VALIDADE_MS = 10 * 60_000;
const MAX_BYTES_BACKUP = 5_000_000;
const AMOSTRA = 20;

/** O que uma escrita enxerga dentro da transação. */
export interface TxBanco {
  consultar(sql: string, ...params: unknown[]): Promise<Array<Record<string, unknown>>>;
  executar(sql: string, ...params: unknown[]): Promise<number>;
}

export interface FonteBanco {
  id: BancoId;
  /** false = só leitura (RH e Descontratos, pela API) */
  escreve: boolean;
  catalogo(): Promise<Catalogo>;
  /** true = o SELECT final devolve cada linha como um json em `_linha` (cortado no banco se grande); false = linhas comuns */
  linhasEmJson: boolean;
  /** quanto tempo o mapa das tabelas vale antes de ser lido de novo (0 = sempre lê) */
  cacheCatalogoMs: number;
  /** roda o SELECT final (já validado e com teto) em transação READ ONLY */
  ler(sql: string, quem: string): Promise<Array<Record<string, unknown>>>;
  /** `desfazer: true` = sempre ROLLBACK ao fim (a prévia). Só existe se `escreve`. */
  transacao<T>(fn: (tx: TxBanco) => Promise<T>, o?: { desfazer?: boolean }): Promise<T>;
}

export interface QuemBanco {
  /** id do usuário do console: prende o código de confirmação */
  usuario: string;
  /** e-mail: vai para o registro */
  email: string;
}

// ------------------------------------------------------------------ pendentes

interface PendenteEscrita {
  tipo: 'escrita';
  usuario: string;
  banco: BancoId;
  sql: string;
  motivo: string;
  linhas: number;
  /** impressão das linhas que a prévia viu (UPDATE/DELETE): se mudaram até a confirmação, nada é gravado */
  impressao: string;
}
interface PendenteDesfazer {
  tipo: 'desfazer';
  usuario: string;
  banco: BancoId;
  alteracao: string;
  motivo: string;
  linhas: number;
}
type Pendente = (PendenteEscrita | PendenteDesfazer) & { criadoEm: number };

export class PendentesBanco {
  private itens = new Map<string, Pendente>();
  constructor(private agora: () => number = Date.now) {}
  guardar(p: PendenteEscrita | PendenteDesfazer): { codigo: string; expiraEm: string } {
    for (const [k, v] of this.itens) if (this.agora() - v.criadoEm > VALIDADE_MS) this.itens.delete(k);
    let codigo: string;
    do codigo = randomBytes(5).toString('hex').toUpperCase();
    while (this.itens.has(codigo));
    const criadoEm = this.agora();
    this.itens.set(codigo, { ...p, criadoEm });
    return { codigo, expiraEm: new Date(criadoEm + VALIDADE_MS).toISOString() };
  }
  /** Gasta o código (uma vez só, preso a quem preparou). Qualquer resultado da confirmação, bom ou ruim, não devolve o código. */
  tirar(codigoBruto: string, usuario: string): Pendente {
    const codigo = String(codigoBruto ?? '').trim().toUpperCase();
    const p = this.itens.get(codigo);
    if (!p) throw new ErroDeEntrada('código desconhecido ou já usado (ou o conector reiniciou desde a prévia): prepare de novo');
    if (p.usuario !== usuario) throw new ErroDeEntrada('este código foi gerado por outro usuário');
    this.itens.delete(codigo);
    if (this.agora() - p.criadoEm > VALIDADE_MS) throw new ErroDeEntrada(`o código venceu (${VALIDADE_MS / 60_000} minutos): prepare de novo`);
    return p;
  }
}

// ------------------------------------------------------------------ contexto

export interface ContextoBanco {
  /** só os bancos ligados; cada um pode falhar ao ser pedido (ex.: o RH não carregou ainda) */
  fontes: Map<BancoId, () => FonteBanco>;
  pendentes: PendentesBanco;
  /** aviso ao João (Telegram, canal avisos) a cada escrita confirmada; injetável para teste */
  avisar: (texto: string) => Promise<unknown> | unknown;
  agora: () => number;
  catalogos: Map<BancoId, { em: number; cat: Catalogo }>;
}

export function criarContextoBanco(
  fontes: Map<BancoId, () => FonteBanco>,
  o: { avisar?: ContextoBanco['avisar']; agora?: () => number } = {},
): ContextoBanco {
  const agora = o.agora ?? Date.now;
  return { fontes, pendentes: new PendentesBanco(agora), avisar: o.avisar ?? (() => undefined), agora, catalogos: new Map() };
}

function bancoValido(v: unknown): BancoId {
  if (v !== 'agente' && v !== 'rh' && v !== 'dsc') throw new ErroDeEntrada('banco: use agente, rh ou dsc');
  return v;
}

function fonteDe(ctx: ContextoBanco, banco: BancoId): FonteBanco {
  const f = ctx.fontes.get(banco);
  if (!f) throw new ErroDeEntrada(`o banco "${banco}" não está ligado neste conector. Ligados: ${[...ctx.fontes.keys()].join(', ') || 'nenhum'}`);
  return f();
}

async function catalogoDe(ctx: ContextoBanco, banco: BancoId, fonte: FonteBanco): Promise<Catalogo> {
  const g = ctx.catalogos.get(banco);
  if (g && fonte.cacheCatalogoMs > 0 && ctx.agora() - g.em < fonte.cacheCatalogoMs) return g.cat;
  const cat = await fonte.catalogo();
  ctx.catalogos.set(banco, { em: ctx.agora(), cat });
  return cat;
}

// ------------------------------------------------------------------ serialização

/** JSON que aguenta bigint, data e bytes (o Prisma devolve int8 como BigInt). */
export function paraJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === 'bigint') return x.toString();
    if (x instanceof Uint8Array) return `\\x${Buffer.from(x).toString('hex')}`;
    return x;
  });
}

/** Linha que passa de `MAX_BYTES_LINHA` vira só o começo dela (o mesmo corte que o banco direto faz). */
function cortarLinhaGrande(linha: Record<string, unknown>): Record<string, unknown> {
  const t = paraJson(linha);
  return Buffer.byteLength(t) > MAX_BYTES_LINHA ? { _linha_cortada_por_tamanho: t.slice(0, 1000) } : linha;
}

/** Corta a lista até caber em `MAX_BYTES_RESPOSTA`. */
function caberNaResposta<T>(linhas: T[]): { linhas: T[]; cortado: boolean } {
  if (paraJson(linhas).length <= MAX_BYTES_RESPOSTA) return { linhas, cortado: false };
  let n = linhas.length;
  while (n > 1 && paraJson(linhas.slice(0, n)).length > MAX_BYTES_RESPOSTA) n = Math.floor(n / 2);
  return { linhas: linhas.slice(0, n), cortado: true };
}

function encurtar(v: unknown, max = 200): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}… (+${v.length - max})` : v;
  if (v && typeof v === 'object') {
    const t = paraJson(v);
    return t.length > max ? `${t.slice(0, max)}… (+${t.length - max})` : v;
  }
  return v;
}

// ------------------------------------------------------------------ esquema e leitura

export async function esquemaBanco(ctx: ContextoBanco, a: { banco: BancoId; tabela?: string }) {
  const banco = bancoValido(a.banco);
  const fonte = fonteDe(ctx, banco);
  const cat = await catalogoDe(ctx, banco, fonte);
  const busca = a.tabela?.trim().toLowerCase();
  const todas = [...cat.tabelas.values()].filter((t) => !tabelaSecreta(t.nome) && colunasBoas(t).length > 0).sort((x, y) => x.nome.localeCompare(y.nome));
  const ocultasTabelas = [...cat.tabelas.values()].filter((t) => tabelaFechada(t)).length;
  const ach = busca ? todas.filter((t) => t.nome.toLowerCase().includes(busca)) : todas;
  const comColunas = ach.length <= 15;
  return {
    banco,
    tabelas: ach.map((t) => ({
      tabela: t.nome,
      ...(t.visao ? { view: true } : {}),
      linhasAprox: t.linhas ?? undefined,
      chave: t.chave.length ? t.chave : undefined,
      ...(comColunas ? { colunas: colunasBoas(t) } : { colunas: colunasBoas(t).length }),
      ...(colunasOcultas(t).length ? { colunasOcultas: colunasOcultas(t).length } : {}),
    })),
    tabelasFechadas: ocultasTabelas,
    ...(comColunas ? {} : { dica: 'muitas tabelas: filtre por "tabela" para ver as colunas de cada uma' }),
    nota: 'Tabelas de segredo (chaves, tokens, sessões, OAuth) e colunas de senha/hash/token não aparecem nem podem ser lidas ou alteradas.',
  };
}

export async function consultarBanco(ctx: ContextoBanco, quem: QuemBanco, a: { banco: BancoId; sql: string }) {
  const banco = bancoValido(a.banco);
  const fonte = fonteDe(ctx, banco);
  const cat = await catalogoDe(ctx, banco, fonte);
  const analise = analisarLeitura(a.sql, cat);
  const recebido = await fonte.ler(montarLeitura(analise, MAX_LINHAS_LEITURA + 1, fonte.linhasEmJson), quem.email);
  // banco direto: o corte de linha grande já foi feito no banco; pela API do sistema, é feito aqui (uma coluna gigante não pode estourar a memória)
  const bruto = fonte.linhasEmJson ? recebido.map((r) => r._linha as Record<string, unknown>) : recebido.map(cortarLinhaGrande);
  const cortadoPorLinhas = bruto.length > MAX_LINHAS_LEITURA;
  const { linhas, cortado: cortadoPorBytes } = caberNaResposta(bruto.slice(0, MAX_LINHAS_LEITURA));
  const cortado = cortadoPorLinhas || cortadoPorBytes;
  return {
    banco,
    colunas: linhas[0] ? Object.keys(linhas[0]) : [],
    linhas: JSON.parse(paraJson(linhas)) as unknown,
    linhasDevolvidas: linhas.length,
    cortado,
    ...(cortado ? { aviso: `resultado cortado (máximo ${MAX_LINHAS_LEITURA} linhas e ${MAX_BYTES_RESPOSTA / 1000} KB): refine com WHERE, LIMIT ou colunas específicas` } : {}),
    ...(analise.restritas.length ? { nota: `lida sem as colunas de segredo de: ${analise.restritas.map((t) => t.nome).join(', ')}` } : {}),
    dica: 'colunas com o mesmo nome em duas tabelas se sobrepõem no resultado: dê apelido (a.id AS a_id)',
  };
}

// ------------------------------------------------------------------ escrita: peças

interface LinhaComChave {
  chave: string[];
  /** a linha como JSON em texto, exata (to_jsonb(...)::text no banco) */
  json: string;
}

function lerLinhas(t: TabelaCat, rows: Array<Record<string, unknown>>): LinhaComChave[] {
  const r = rows.map((x) => ({ chave: t.chave.map((_, i) => String(x[`__pk${i}`])), json: String(x.__linha) }));
  return r.sort((a, b) => (JSON.stringify(a.chave) < JSON.stringify(b.chave) ? -1 : 1));
}

function lerChaves(t: TabelaCat, rows: Array<Record<string, unknown>>): string[][] {
  return rows.map((x) => t.chave.map((_, i) => String(x[`__pk${i}`]))).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

const impressaoDe = (linhas: LinhaComChave[]): string => createHash('sha256').update(JSON.stringify(linhas.map((l) => [l.chave, l.json]))).digest('hex');
const mesmasChaves = (a: string[][], b: string[][]): boolean => JSON.stringify(a) === JSON.stringify(b);
const achatar = (chaves: string[][]): string[] => chaves.flat();

/** Compara JSON ignorando a ordem das chaves (jsonb ordena, mas o que veio do backup pode vir de outra versão). */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
const iguais = (a: string, b: string): boolean => canonico(JSON.parse(a)) === canonico(JSON.parse(b));

/** Amostra legível: UPDATE mostra só as colunas que mudam (de → para); INSERT e DELETE mostram a linha. */
function amostraDe(plano: Pick<PlanoEscrita, 'tipo' | 'tabela'>, antes: LinhaComChave[], depois: LinhaComChave[]): unknown[] {
  const pk = (l: LinhaComChave) => Object.fromEntries(plano.tabela.chave.map((c, i) => [c, l.chave[i]]));
  if (plano.tipo === 'update') {
    return antes.slice(0, AMOSTRA).map((a, i) => {
      const d = depois.find((x) => JSON.stringify(x.chave) === JSON.stringify(a.chave)) ?? depois[i];
      const ao = JSON.parse(a.json) as Record<string, unknown>;
      const dobj = d ? (JSON.parse(d.json) as Record<string, unknown>) : {};
      const mudou: Record<string, unknown> = {};
      for (const k of Object.keys(dobj)) if (canonico(ao[k]) !== canonico(dobj[k])) mudou[k] = { de: encurtar(ao[k]), para: encurtar(dobj[k]) };
      return { chave: pk(a), mudou: Object.keys(mudou).length ? mudou : 'sem mudança de valor' };
    });
  }
  const base = plano.tipo === 'insert' ? depois : antes;
  return base.slice(0, AMOSTRA).map((l) => ({ chave: pk(l), linha: Object.fromEntries(Object.entries(JSON.parse(l.json) as Record<string, unknown>).map(([k, v]) => [k, encurtar(v)])) }));
}

function novoId(): string {
  return `bk-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

const SQL_REGISTRO = `INSERT INTO mcp_banco_alteracoes (id, banco, usuario_id, usuario_email, tipo, tabela, sql_texto, motivo, linhas, chaves, antes, depois, desfaz_de)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::int, $10::jsonb, $11::jsonb, $12::jsonb, $13)`;

async function registrar(
  tx: TxBanco,
  r: { id: string; banco: BancoId; quem: QuemBanco; tipo: string; tabela: string; sql: string; motivo: string; chaves: string[][]; antes?: LinhaComChave[]; depois?: LinhaComChave[]; desfazDe?: string },
): Promise<void> {
  const arr = (ls?: LinhaComChave[]) => (ls ? `[${ls.map((l) => l.json).join(',')}]` : null);
  const antes = arr(r.antes);
  const depois = arr(r.depois);
  if (Buffer.byteLength(antes ?? '') + Buffer.byteLength(depois ?? '') > MAX_BYTES_BACKUP) {
    throw new ErroDeEntrada('as linhas são grandes demais para guardar o backup (mais de 5 MB): nada foi gravado. Reduza o número de linhas ou de colunas do pedido');
  }
  await tx.executar(SQL_REGISTRO, r.id, r.banco, r.quem.usuario, r.quem.email, r.tipo, r.tabela, r.sql.slice(0, 20_000), r.motivo, r.chaves.length, JSON.stringify(r.chaves), antes, depois, r.desfazDe ?? null);
}

function motivoValido(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : '';
  if (m.length < 5) throw new ErroDeEntrada('diga o motivo em uma frase (mínimo 5 caracteres): fica no registro e no aviso ao João');
  return m.slice(0, 300);
}

function exigirEscrita(fonte: FonteBanco, banco: BancoId): void {
  if (fonte.escreve) return;
  throw new ErroDeEntrada(
    banco === 'rh' || banco === 'dsc'
      ? `no banco "${banco}" a escrita não é por SQL: o servidor dele não aceita SQL livre de escrita. Use sistemas_preparar_alteracao (inserir/atualizar/apagar com filtro) e sistemas_confirmar_alteracao${banco === 'dsc' ? ' com sistema="descontratos"' : ''}: também têm prévia, backup e registro no servidor`
      : `o banco "${banco}" é só leitura aqui`,
  );
}

/** O trabalho da escrita dentro da transação. Na prévia, `esperado` não existe e a transação é desfeita; na confirmação, tranca as linhas e confere. */
async function rodarEscrita(
  tx: TxBanco,
  plano: PlanoEscrita,
  esperado?: { linhas: number; impressao: string },
): Promise<{ antes: LinhaComChave[]; depois: LinhaComChave[]; chaves: string[][] }> {
  const t = plano.tabela;
  let antes: LinhaComChave[] = [];
  if (plano.tipo !== 'insert') {
    antes = lerLinhas(t, await tx.consultar(sqlAntes(plano, MAX_LINHAS_ESCRITA, esperado !== undefined)));
    if (antes.length > MAX_LINHAS_ESCRITA) throw new ErroDeEntrada(`o WHERE pega mais de ${MAX_LINHAS_ESCRITA} linhas: o teto por escrita é ${MAX_LINHAS_ESCRITA}. Restrinja o WHERE ou faça em lotes`);
    if (antes.length === 0) throw new ErroDeEntrada('nenhuma linha casa com o WHERE: nada a fazer');
    if (esperado && (antes.length !== esperado.linhas || impressaoDe(antes) !== esperado.impressao)) {
      throw new ErroDeEntrada('as linhas mudaram desde a prévia: nada foi gravado. Prepare de novo');
    }
  }
  const tocadas = lerChaves(t, await tx.consultar(sqlExecutar(plano)));
  if (tocadas.length > MAX_LINHAS_ESCRITA) throw new ErroDeEntrada(`o comando mexeria em ${tocadas.length} linhas: o teto por escrita é ${MAX_LINHAS_ESCRITA}. Nada foi gravado`);
  if (plano.tipo !== 'insert' && !mesmasChaves(tocadas, antes.map((l) => l.chave))) {
    throw new ErroDeEntrada('o comando tocou linhas diferentes das que a prévia mostrou: nada foi gravado. Prepare de novo');
  }
  if (esperado && tocadas.length !== esperado.linhas) throw new ErroDeEntrada(`a prévia mostrou ${esperado.linhas} linha(s) e agora seriam ${tocadas.length}: nada foi gravado. Prepare de novo`);
  let depois: LinhaComChave[] = [];
  if (plano.tipo !== 'delete' && tocadas.length) depois = lerLinhas(t, await tx.consultar(sqlPorChave(t, tocadas.length), ...achatar(tocadas)));
  return { antes, depois, chaves: tocadas };
}

// ------------------------------------------------------------------ escrita: passo 1 e 2

export async function prepararEscrita(ctx: ContextoBanco, quem: QuemBanco, a: { banco: BancoId; sql: string; motivo: string }) {
  const banco = bancoValido(a.banco);
  const fonte = fonteDe(ctx, banco);
  exigirEscrita(fonte, banco);
  const motivo = motivoValido(a.motivo);
  const cat = await catalogoDe(ctx, banco, fonte);
  const plano = analisarEscrita(a.sql, cat);
  const r = await fonte.transacao((tx) => rodarEscrita(tx, plano), { desfazer: true });
  const avisos: string[] = [];
  if (plano.tipo === 'update') {
    const nenhuma = r.antes.every((l) => {
      const d = r.depois.find((x) => JSON.stringify(x.chave) === JSON.stringify(l.chave));
      return d !== undefined && iguais(l.json, d.json);
    });
    if (nenhuma) avisos.push('nenhuma linha mudaria de valor com este UPDATE');
  }
  const { codigo, expiraEm } = ctx.pendentes.guardar({ tipo: 'escrita', usuario: quem.usuario, banco, sql: plano.sql, motivo, linhas: r.chaves.length, impressao: impressaoDe(r.antes) });
  return {
    banco,
    operacao: plano.tipo,
    tabela: plano.tabela.nome,
    linhas: r.chaves.length,
    amostra: amostraDe(plano, r.antes, r.depois),
    ...(r.chaves.length > AMOSTRA ? { amostraDe: `as primeiras ${AMOSTRA} de ${r.chaves.length}` } : {}),
    avisos,
    confirmacao: codigo,
    expiraEm,
    instrucao: `Nada foi gravado (o comando rodou numa transação e foi DESFEITO). Mostre o resumo e a amostra à pessoa e, SÓ se ela aprovar, chame banco_confirmar_escrita com confirmacao="${codigo}" (vale ${VALIDADE_MS / 60_000} minutos, uma vez). O backup das linhas fica em mcp_banco_alteracoes e dá para desfazer com banco_preparar_desfazer.`,
  };
}

function textoAviso(quem: QuemBanco, banco: BancoId, oque: string, tabela: string, n: number, motivo: string, id: string): string {
  return `🗄️ Banco ${banco}: ${quem.email} ${oque} em ${tabela} (${n} linha${n === 1 ? '' : 's'}) pelo conector do claude.ai. Motivo: ${motivo}. Registro ${id} (desfazer: banco_preparar_desfazer).`;
}

async function avisarSemFalhar(ctx: ContextoBanco, texto: string): Promise<boolean> {
  try {
    const r = await ctx.avisar(texto);
    return r !== false;
  } catch {
    return false;
  }
}

export interface ResultadoEscrita {
  banco: BancoId;
  linhasGravadas: number;
  registro: string;
  avisoTelegram: string;
  [campo: string]: unknown;
}

export async function confirmarEscrita(ctx: ContextoBanco, quem: QuemBanco, a: { confirmacao: string }, rastro: { operacao?: string; tabela?: string; resultado?: string } = {}): Promise<ResultadoEscrita> {
  const p = ctx.pendentes.tirar(a.confirmacao, quem.usuario);
  if (p.tipo === 'desfazer') return confirmarDesfazer(ctx, quem, p, rastro);
  const fonte = fonteDe(ctx, p.banco);
  exigirEscrita(fonte, p.banco);
  const cat = await catalogoDe(ctx, p.banco, fonte);
  const plano = analisarEscrita(p.sql, cat); // vale de novo: o catálogo pode ter mudado
  rastro.operacao = plano.tipo;
  rastro.tabela = plano.tabela.nome;
  const id = novoId();
  let r: Awaited<ReturnType<typeof rodarEscrita>>;
  try {
    r = await fonte.transacao(async (tx) => {
      const x = await rodarEscrita(tx, plano, { linhas: p.linhas, impressao: p.impressao });
      await registrar(tx, { id, banco: p.banco, quem, tipo: plano.tipo, tabela: plano.tabela.nome, sql: plano.sql, motivo: p.motivo, chaves: x.chaves, antes: plano.tipo === 'insert' ? undefined : x.antes, depois: plano.tipo === 'delete' ? undefined : x.depois });
      return x;
    });
  } catch (e) {
    rastro.resultado = `recusado: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    if (e instanceof ErroDeEntrada) throw e;
    throw new ErroDeEntrada(`a gravação falhou e foi desfeita (nada mudou): ${e instanceof Error ? e.message.slice(0, 300) : String(e)}. O código foi gasto: prepare de novo. Se o erro foi de conexão, confira em mcp_banco_alteracoes se chegou a gravar antes de repetir`);
  }
  rastro.resultado = 'ok';
  const avisado = await avisarSemFalhar(ctx, textoAviso(quem, p.banco, plano.tipo === 'insert' ? 'inseriu' : plano.tipo === 'update' ? 'atualizou' : 'apagou', plano.tabela.nome, r.chaves.length, p.motivo, id));
  return {
    banco: p.banco,
    operacao: plano.tipo,
    tabela: plano.tabela.nome,
    linhasGravadas: r.chaves.length,
    registro: id,
    backup: plano.tipo === 'insert' ? 'as linhas inseridas ficam no registro (depois); desfazer apaga elas' : 'as linhas de antes ficaram guardadas em mcp_banco_alteracoes',
    desfazer: `banco_preparar_desfazer com alteracao="${id}"`,
    avisoTelegram: avisado ? 'enviado' : 'NÃO consegui avisar no Telegram (a gravação vale; avise o João)',
  };
}

// ------------------------------------------------------------------ desfazer

interface Registro {
  id: string;
  banco: string;
  tipo: string;
  tabela: string;
  desfeito: boolean;
  chaves: string[][];
  antes: string[];
  depois: string[];
}

async function lerRegistro(tx: TxBanco, id: string): Promise<Registro> {
  const m = await tx.consultar('SELECT id, banco, tipo, tabela, (desfeito_em IS NOT NULL) AS desfeito, chaves::text AS chaves FROM mcp_banco_alteracoes WHERE id = $1', id);
  if (!m[0]) throw new ErroDeEntrada(`registro "${id}" não existe em mcp_banco_alteracoes`);
  const elementos = async (col: 'antes' | 'depois') =>
    (
      await tx.consultar(
        `SELECT e.v::text AS v FROM mcp_banco_alteracoes m, jsonb_array_elements(m.${col}) WITH ORDINALITY AS e(v, ord) WHERE m.id = $1 AND jsonb_typeof(m.${col}) = 'array' ORDER BY e.ord`,
        id,
      )
    ).map((x) => String(x.v));
  const r = m[0];
  return { id, banco: String(r.banco), tipo: String(r.tipo), tabela: String(r.tabela), desfeito: r.desfeito === true, chaves: JSON.parse(String(r.chaves)) as string[][], antes: await elementos('antes'), depois: await elementos('depois') };
}

/** O que o desfazer faz dentro da transação; devolve as chaves tocadas. Na confirmação (`travar`) as linhas ficam trancadas. */
async function rodarDesfazer(tx: TxBanco, t: TabelaCat, reg: Registro, travar: boolean): Promise<void> {
  const n = reg.chaves.length;
  const atuais = n ? lerLinhas(t, await tx.consultar(sqlPorChave(t, n, travar), ...achatar(reg.chaves))) : [];
  const porChave = new Map(atuais.map((l) => [JSON.stringify(l.chave), l.json]));
  if (reg.tipo === 'delete') {
    if (atuais.length) throw new ErroDeEntrada(`já existe linha com a mesma chave (${atuais.length}): desfazer o DELETE colidiria. Confira com banco_consultar`);
    await tx.executar(sqlReinserir(t), `[${reg.antes.join(',')}]`);
    return;
  }
  // UPDATE e INSERT: as linhas precisam estar como a alteração as deixou; senão alguém mexeu depois e o desfazer apagaria o trabalho dele
  reg.chaves.forEach((c, i) => {
    const agora = porChave.get(JSON.stringify(c));
    if (agora === undefined || !iguais(agora, reg.depois[i] ?? 'null')) {
      throw new ErroDeEntrada(`a linha de chave ${JSON.stringify(c)} ${agora === undefined ? 'não existe mais' : 'mudou depois desta alteração'}: o desfazer automático não é seguro. Confira com banco_consultar e corrija por banco_preparar_escrita`);
    }
  });
  if (reg.tipo === 'update') {
    for (let i = 0; i < n; i++) await tx.executar(sqlRestaurarLinha(t), reg.antes[i]!, ...reg.chaves[i]!);
    return;
  }
  const apagadas = await tx.consultar(sqlApagarPorChave(t, n), ...achatar(reg.chaves));
  if (apagadas.length !== n) throw new ErroDeEntrada(`o desfazer apagaria ${apagadas.length} linha(s) em vez de ${n}: nada foi feito`);
}

export async function prepararDesfazer(ctx: ContextoBanco, quem: QuemBanco, a: { alteracao: string; banco?: BancoId }) {
  const banco = bancoValido(a.banco ?? 'agente');
  const fonte = fonteDe(ctx, banco);
  exigirEscrita(fonte, banco);
  const id = String(a.alteracao ?? '').trim();
  if (!/^bk-[a-z0-9-]{6,40}$/.test(id)) throw new ErroDeEntrada('alteracao: use o registro que banco_confirmar_escrita devolveu (bk-…)');
  const cat = await catalogoDe(ctx, banco, fonte);
  const reg = await fonte.transacao(async (tx) => {
    const r = await lerRegistro(tx, id);
    validarRegistro(r, banco, cat);
    await rodarDesfazer(tx, cat.tabelas.get(r.tabela.toLowerCase())!, r, false);
    return r;
  }, { desfazer: true });
  const t = cat.tabelas.get(reg.tabela.toLowerCase())!;
  const { codigo, expiraEm } = ctx.pendentes.guardar({ tipo: 'desfazer', usuario: quem.usuario, banco, alteracao: id, motivo: `desfazer ${id}`, linhas: reg.chaves.length });
  const linhas = reg.tipo === 'delete' ? reg.antes : reg.tipo === 'update' ? reg.antes : reg.depois;
  return {
    banco,
    desfaz: { registro: id, operacao: reg.tipo, tabela: t.nome },
    linhas: reg.chaves.length,
    amostra: linhas.slice(0, AMOSTRA).map((j, i) => ({ chave: Object.fromEntries(t.chave.map((c, k) => [c, reg.chaves[i]![k]])), volta: reg.tipo === 'insert' ? 'a linha inserida será apagada' : Object.fromEntries(Object.entries(JSON.parse(j) as Record<string, unknown>).map(([k, v]) => [k, encurtar(v)])) })),
    confirmacao: codigo,
    expiraEm,
    instrucao: `Nada foi desfeito ainda (rodou numa transação e foi desfeita). Mostre à pessoa o que volta e, SÓ se ela aprovar, chame banco_confirmar_escrita com confirmacao="${codigo}" (vale ${VALIDADE_MS / 60_000} minutos, uma vez).`,
  };
}

function validarRegistro(r: Registro, banco: BancoId, cat: Catalogo): void {
  if (r.banco !== banco) throw new ErroDeEntrada(`o registro ${r.id} é do banco "${r.banco}", não "${banco}"`);
  if (!['insert', 'update', 'delete'].includes(r.tipo)) throw new ErroDeEntrada(`o registro ${r.id} é um ${r.tipo}: só se desfaz INSERT, UPDATE ou DELETE`);
  if (r.desfeito) throw new ErroDeEntrada(`o registro ${r.id} já foi desfeito`);
  const t = cat.tabelas.get(r.tabela.toLowerCase());
  if (!t || tabelaFechada(t) || t.chave.length === 0 || TABELAS_SO_LEITURA.has(t.nome.toLowerCase())) throw new ErroDeEntrada(`a tabela ${r.tabela} não existe mais ou não aceita desfazer`);
  if (t.chave.some((c) => colunaSecreta(c))) throw new ErroDeEntrada('a chave da tabela é coluna de segredo');
  const esperado = r.tipo === 'delete' ? r.antes.length : r.tipo === 'update' ? Math.min(r.antes.length, r.depois.length) : r.depois.length;
  if (r.chaves.length === 0 || esperado !== r.chaves.length) throw new ErroDeEntrada(`o registro ${r.id} está incompleto (chaves ${r.chaves.length}, linhas ${esperado}): não dá para desfazer sozinho`);
}

async function confirmarDesfazer(ctx: ContextoBanco, quem: QuemBanco, p: PendenteDesfazer, rastro: { operacao?: string; tabela?: string; resultado?: string }): Promise<ResultadoEscrita> {
  const fonte = fonteDe(ctx, p.banco);
  exigirEscrita(fonte, p.banco);
  const cat = await catalogoDe(ctx, p.banco, fonte);
  const id = novoId();
  let reg: Registro;
  try {
    reg = await fonte.transacao(async (tx) => {
      const r = await lerRegistro(tx, p.alteracao);
      validarRegistro(r, p.banco, cat);
      const t = cat.tabelas.get(r.tabela.toLowerCase())!;
      await rodarDesfazer(tx, t, r, true);
      const marcou = await tx.executar('UPDATE mcp_banco_alteracoes SET desfeito_em = now(), desfeito_por = $2 WHERE id = $1 AND desfeito_em IS NULL', r.id, quem.email);
      if (marcou !== 1) throw new ErroDeEntrada(`o registro ${r.id} já foi desfeito por outra chamada: nada foi feito`);
      const linhasDe = (js: string[]) => js.map((j, i) => ({ chave: r.chaves[i]!, json: j }));
      await registrar(tx, {
        id, banco: p.banco, quem, tipo: 'desfazer', tabela: t.nome, sql: `desfazer ${r.id}`, motivo: p.motivo, chaves: r.chaves, desfazDe: r.id,
        antes: r.tipo === 'delete' ? undefined : linhasDe(r.depois),
        depois: r.tipo === 'insert' ? undefined : linhasDe(r.antes),
      });
      return r;
    });
  } catch (e) {
    rastro.resultado = `recusado: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    if (e instanceof ErroDeEntrada) throw e;
    throw new ErroDeEntrada(`o desfazer falhou e foi desfeito (nada mudou): ${e instanceof Error ? e.message.slice(0, 300) : String(e)}. O código foi gasto: prepare de novo`);
  }
  rastro.operacao = `desfazer ${reg.tipo}`;
  rastro.tabela = reg.tabela;
  rastro.resultado = 'ok';
  const avisado = await avisarSemFalhar(ctx, textoAviso(quem, p.banco, `desfez o ${reg.tipo.toUpperCase()} ${reg.id}`, reg.tabela, reg.chaves.length, p.motivo, id));
  return {
    banco: p.banco,
    desfeito: { registro: reg.id, operacao: reg.tipo, tabela: reg.tabela },
    linhasGravadas: reg.chaves.length,
    registro: id,
    avisoTelegram: avisado ? 'enviado' : 'NÃO consegui avisar no Telegram (o desfazer vale; avise o João)',
  };
}

// ------------------------------------------------------------------ registro das ferramentas

/** A auditoria do conector leva o SQL cortado e o motivo, nunca o conteúdo devolvido. */
function auditarBanco(auditar: Auditar): Auditar {
  return (r) => {
    const a = (r.argumentos ?? {}) as Record<string, unknown>;
    auditar({ ...r, argumentos: { ...a, sql: typeof a.sql === 'string' ? a.sql.slice(0, 500) : undefined } });
  };
}

const BANCO = z.enum(['agente', 'rh', 'dsc']).describe('agente = banco do agente-dt; rh = RH/Caixa/Financeiro; dsc = Descontratos/Ficha');

export function registrarBanco(server: McpServer, ctx: ContextoBanco, quem: QuemBanco, auditarBruto: Auditar): void {
  const auditar = auditarBanco(auditarBruto);
  server.registerTool(
    'banco_esquema',
    {
      title: 'Banco: mapa das tabelas e colunas',
      description:
        'O mapa de um banco da Doutor Digital: tabelas, colunas, chave primária e número aproximado de linhas. Comece por aqui antes de montar um SQL. ' +
        'Tabelas e colunas de segredo (chaves, tokens, sessões, OAuth, senhas, hashes) não aparecem. Use "tabela" para filtrar pelo nome (mostra as colunas). Só leitura.',
      inputSchema: { banco: BANCO, tabela: z.string().max(60).optional().describe('filtra pelo nome da tabela') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('banco_esquema', args, auditar, () => esquemaBanco(ctx, args)),
  );
  server.registerTool(
    'banco_consultar',
    {
      title: 'Banco: consulta SELECT',
      description:
        'Roda UM SELECT (ou WITH … SELECT) em um dos bancos (agente, rh, dsc), em transação só-leitura, com limite de 30 s, no máximo 500 linhas e 200 KB. ' +
        'Um comando só, sem ";" no meio. Recusa: tabelas e colunas de segredo (chaves, tokens, sessões, OAuth, senhas, hashes), funções que leem arquivo ou executam texto, ' +
        'catálogo do sistema (pg_*, information_schema), outros esquemas, SET/DDL/escrita. Tabelas com coluna de segredo são lidas sem ela (select * funciona); linha muito grande (mais de 50 KB) vem cortada. ' +
        'Dado de paciente e de RH é sensível: peça só as colunas de que precisa. Para alterar use banco_preparar_escrita.',
      inputSchema: { banco: BANCO, sql: z.string().min(6).max(20_000).describe('um SELECT, ex.: select slug, name from units order by 1 limit 20') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('banco_consultar', args, auditar, () => consultarBanco(ctx, quem, args)),
  );
  server.registerTool(
    'banco_preparar_escrita',
    {
      title: 'Banco: preparar escrita (passo 1 de 2)',
      description:
        'PASSO 1 de 2 para ESCREVER no banco do agente (banco="agente"): UM comando INSERT INTO t (colunas) VALUES (…), UPDATE t SET c = … WHERE …, ou DELETE FROM t WHERE …. ' +
        'O comando roda numa transação e é DESFEITO: devolve quantas linhas mudam e uma amostra antes → depois, mais um código. Mostre isto à pessoa e SÓ chame banco_confirmar_escrita se ela aprovar. ' +
        'Teto de 200 linhas por escrita; UPDATE e DELETE exigem WHERE; a tabela precisa de chave primária; sem DDL, sem vários comandos, sem RETURNING/ON CONFLICT, sem apelido de tabela. ' +
        'Colunas e tabelas de segredo estão fechadas. RH e Descontratos: use sistemas_preparar_alteracao. Dê o "motivo" (vai para o registro e para o aviso ao João).',
      inputSchema: { banco: BANCO, sql: z.string().min(10).max(20_000), motivo: z.string().min(5).max(300).describe('por que — fica no registro') },
      // roda o comando (e desfaz): não é "só leitura" para o cliente
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => executar('banco_preparar_escrita', args, auditar, () => prepararEscrita(ctx, quem, args)),
  );
  server.registerTool(
    'banco_preparar_desfazer',
    {
      title: 'Banco: preparar o desfazer de uma escrita (passo 1 de 2)',
      description:
        'PASSO 1 de 2 para DESFAZER uma escrita que banco_confirmar_escrita fez (o registro bk-… que ela devolveu): devolve as linhas ao que eram (UPDATE), reinsere (DELETE) ou apaga (INSERT). ' +
        'Só se as linhas ainda estiverem como a escrita as deixou; se alguém mexeu depois, recusa. Roda numa transação e desfaz; confirme com banco_confirmar_escrita.',
      inputSchema: { alteracao: z.string().min(6).max(60).describe('o registro (bk-…) devolvido por banco_confirmar_escrita; lista: select id, tabela, tipo, linhas, created_at from mcp_banco_alteracoes order by created_at desc limit 20 (banco agente)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => executar('banco_preparar_desfazer', args, auditar, () => prepararDesfazer(ctx, quem, args)),
  );
  server.registerTool(
    'banco_confirmar_escrita',
    {
      title: 'Banco: confirmar escrita ou desfazer (passo 2 de 2)',
      description:
        'PASSO 2 de 2: GRAVA a escrita (ou o desfazer) preparada, com o código de banco_preparar_escrita / banco_preparar_desfazer. Só chame depois que a pessoa aprovou o resumo. ' +
        'O código vale 10 minutos e uma vez, só para quem preparou. Se as linhas mudaram desde a prévia, nada é gravado. Guarda o backup, registra e avisa o João no Telegram.',
      inputSchema: { confirmacao: z.string().min(4).max(32) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => {
      const rastro: { operacao?: string; tabela?: string; resultado?: string } = {};
      const comRastro: Auditar = (r) => auditar({ ...r, argumentos: { confirmacao: (r.argumentos as { confirmacao?: string }).confirmacao, operacao: rastro.operacao, tabela: rastro.tabela, resultado: rastro.resultado ?? (r.ok ? 'ok' : undefined) } });
      return executar('banco_confirmar_escrita', args, comRastro, () => confirmarEscrita(ctx, quem, args, rastro));
    },
  );
}

/**
 * O portão: as ferramentas `banco_*` só existem para quem está na lista (MCP_BANCO_EMAILS, usuários ativos do console) E se há ao menos um banco ligado.
 * Quem escreve no Kommo (MCP_ESCRITA_EMAILS) NÃO ganha banco por isso.
 */
export function registrarBancoSePermitido(server: McpServer, ctx: ContextoBanco, quem: QuemBanco, permitidos: ReadonlySet<string>, auditar: Auditar): boolean {
  if (!quem.usuario || !permitidos.has(quem.usuario)) return false;
  if (ctx.fontes.size === 0) return false;
  registrarBanco(server, ctx, quem, auditar);
  return true;
}
