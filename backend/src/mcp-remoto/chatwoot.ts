/**
 * Chatwoot pelo claude.ai — o CRM de atendimento novo (https://atendimento.doutordigitalconsultoria.com, 11/11/2026).
 * Pedido do João: a Suzanne monta a estrutura nova do atendimento no Chatwoot e migra parte do Kommo aos poucos; o conector
 * precisa CRIAR e ALTERAR tudo dentro da conta, não só ler ("100%").
 *
 * Fala com a API da CONTA (`/api/v1/accounts/<conta>/...`) com o token do usuário "Conector Claude" (administrador da conta).
 * A conta é fixa (CHATWOOT_CONTA_ID): o caminho que chega é sempre relativo a ela — sem `..`, sem URL absoluta, sem sair da
 * conta. Platform API e super admin não existem aqui (criar outra conta ou mexer na instalação é só pelo servidor).
 *
 * Criar e alterar é DIRETO (caixas, contatos, etiquetas, agentes, equipes, respostas prontas, atributos, automações, conversas).
 * Em DOIS passos, como a escrita do Kommo e o envio do WhatsApp: APAGAR qualquer coisa e tudo que MANDA mensagem a cliente
 * (mensagem pública numa conversa, conversa nova com mensagem, campanha). `chatwoot_preparar` mostra e devolve um código preso a
 * quem pediu; `chatwoot_confirmar` executa. Cada apagamento confirmado avisa o João no Telegram.
 */
import { configDaUnidade, contaDaUnidade, contasExplicitas, unidadeDaCaixa, unidadesDaConta } from '../lib/chatwoot-unidades.js';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';

export interface ContaChatwoot {
  url: string;
  conta: number;
  token: string;
}

export type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Acao {
  metodo: Metodo;
  caminho: string;
  corpo?: Record<string, unknown>;
  query?: Record<string, string>;
  motivo: string;
}

export interface ContextoChatwoot {
  conta: ContaChatwoot | null;
  fetch: typeof fetch;
  agora: () => number;
  pendentes: Map<string, { usuario: string; acao: Acao; criadoEm: number }>;
  /** Aviso ao João (Telegram) quando algo é apagado; injetável para teste. */
  avisar: (texto: string) => Promise<unknown> | unknown;
}

export const VALIDADE_MS = 10 * 60_000;

export function criarContextoChatwoot(
  conta: ContaChatwoot | null,
  o: { fetch?: typeof fetch; agora?: () => number; avisar?: (texto: string) => Promise<unknown> | unknown } = {},
): ContextoChatwoot {
  return { conta, fetch: o.fetch ?? globalThis.fetch, agora: o.agora ?? Date.now, pendentes: new Map(), avisar: o.avisar ?? (() => undefined) };
}

/** Sem URL, token e conta, null: as ferramentas nem aparecem. */
export function contaChatwootDoAmbiente(e: NodeJS.ProcessEnv = process.env): ContaChatwoot | null {
  const token = e.CHATWOOT_API_TOKEN?.trim();
  const conta = Number(e.CHATWOOT_CONTA_ID?.trim());
  if (!token || !Number.isInteger(conta) || conta <= 0) return null;
  const url = (e.CHATWOOT_URL?.trim() || 'https://atendimento.doutordigitalconsultoria.com').replace(/\/+$/, '');
  return { url, conta, token };
}

/**
 * O token do Chatwoot DESTA unidade: `CHATWOOT_API_TOKEN_<SUFIXO>` (o usuário «Conector» criado na conta dela), ou, sem ele, o global
 * (`CHATWOOT_API_TOKEN`, o de Parauapebas). Assim um token que vaze abre UMA clínica só. O valor nunca é impresso nem logado.
 */
function tokenDaUnidade(slug: string, e: NodeJS.ProcessEnv): string | undefined {
  const sufixo = configDaUnidade(slug)?.envSufixo;
  return (sufixo ? e[`CHATWOOT_API_TOKEN_${sufixo}`]?.trim() : undefined) || e.CHATWOOT_API_TOKEN?.trim() || undefined;
}

/**
 * A conta do Chatwoot de uma UNIDADE: a URL do ambiente, o id da conta da unidade e o token dela (`tokenDaUnidade`). Unidade sem conta
 * própria (Parauapebas) fica na conta do ambiente. Unidade DESCONHECIDA ou com configuração descartada devolve `null`: quem chama RECUSA,
 * sem falar com o Chatwoot — `null` aqui nunca quer dizer «conta 1».
 */
export function contaChatwootDaUnidade(slug: string, e: NodeJS.ProcessEnv = process.env): ContaChatwoot | null {
  const base = contaChatwootDoAmbiente(e);
  const id = contaDaUnidade(slug);
  if (!base || id === undefined) return null;
  const token = tokenDaUnidade(slug, e);
  if (!token) return null;
  return { url: base.url, conta: id ?? base.conta, token };
}

/**
 * Esta conta (id) é a do AMBIENTE (a de Parauapebas)? É a regra única: a conta do ambiente é a de `CHATWOOT_CONTA_ID`, desde que nenhuma
 * unidade a use explicitamente. Nunca copie esta conta em outro lugar.
 */
export function ehContaDoAmbiente(contaId: number, e: NodeJS.ProcessEnv = process.env): boolean {
  const amb = contaChatwootDoAmbiente(e);
  return !!amb && amb.conta === contaId && !contasExplicitas().includes(contaId);
}

let ambienteGuardado: { chave: string; ctx: ContextoChatwoot } | null = null;
/**
 * O contexto da conta do ambiente, UM só (cada evento do webhook e cada recibo de leitura reaproveitam; o cache por conta depende de ser o
 * mesmo objeto). Usa o `fetch` do momento da chamada (não o do momento em que foi criado). Refeito se URL, conta ou token do ambiente mudarem.
 */
export function contextoDoAmbiente(e: NodeJS.ProcessEnv = process.env): ContextoChatwoot | null {
  const conta = contaChatwootDoAmbiente(e);
  if (!conta) return null;
  const chave = `${conta.url}\u0000${conta.conta}\u0000${conta.token}`;
  if (!ambienteGuardado || ambienteGuardado.chave !== chave) ambienteGuardado = { chave, ctx: criarContextoChatwoot(conta, { fetch: ((u: Parameters<typeof fetch>[0], o?: RequestInit) => globalThis.fetch(u, o)) as typeof fetch }) };
  return ambienteGuardado.ctx;
}

/** Só para os testes. */
export const esquecerContextoDoAmbiente = (): void => {
  ambienteGuardado = null;
};

/** Todas as contas que o servidor conhece: a do ambiente primeiro, depois as das unidades (sem repetir). */
export function contasDoChatwoot(e: NodeJS.ProcessEnv = process.env): number[] {
  const base = contaChatwootDoAmbiente(e);
  const l: number[] = base ? [base.conta] : [];
  for (const c of contasExplicitas()) if (!l.includes(c)) l.push(c);
  return l;
}

const contextosPorConta = new WeakMap<ContextoChatwoot, Map<string, ContextoChatwoot>>();

/**
 * O contexto para uma conta (e token) diferentes dentro da mesma instalação: mesmo `fetch`, mesmo relógio. Se a conta pedida é EXATAMENTE a que
 * o contexto já tem (mesma URL, conta e token) devolve o PRÓPRIO contexto (identidade: Parauapebas continua com o mesmo objeto). O clone
 * tem as próprias confirmações pendentes: uma ação preparada numa conta nunca pode ser confirmada em outra.
 */
export function contextoDaContaChatwoot(ctx: ContextoChatwoot, conta: ContaChatwoot): ContextoChatwoot {
  const atual = ctx.conta;
  if (atual && atual.url === conta.url && atual.conta === conta.conta && atual.token === conta.token) return ctx;
  let por = contextosPorConta.get(ctx);
  if (!por) contextosPorConta.set(ctx, (por = new Map()));
  const chave = `${conta.url}\u0000${conta.conta}\u0000${conta.token}`;
  let c = por.get(chave);
  if (!c) por.set(chave, (c = { ...ctx, conta: { ...conta }, pendentes: new Map() }));
  return c;
}

/**
 * O contexto da conta da UNIDADE, ou `null` se a unidade é desconhecida/inválida (RECUSAR: não chamar o Chatwoot). O `ambiente` só entra para
 * a URL e o token: o `ctx` pode ser o de qualquer conta da mesma instalação.
 */
export function contextoDaUnidade(ctx: ContextoChatwoot, slug: string, e: NodeJS.ProcessEnv = process.env): ContextoChatwoot | null {
  const conta = contaChatwootDaUnidade(slug, e);
  return conta ? contextoDaContaChatwoot(ctx, conta) : null;
}

/** A unidade tem o token PRÓPRIO configurado (`CHATWOOT_API_TOKEN_<SUFIXO>`), em vez de cair no global? */
export function temTokenProprio(slug: string, e: NodeJS.ProcessEnv = process.env): boolean {
  const sufixo = configDaUnidade(slug)?.envSufixo;
  return !!sufixo && !!e[`CHATWOOT_API_TOKEN_${sufixo}`]?.trim();
}

/**
 * A unidade «dona» da conta `contaId` e o contexto dela. Entre as unidades da conta (ordem alfabética do slug) vale a primeira COM token próprio;
 * se nenhuma tem, a primeira com o token global como reserva (`propria: false`). Assim o resultado não depende de qual unidade vem primeiro, e
 * `propria` diz se a conta tem credencial só dela. A conta do ambiente devolve o próprio `ctx` (sem unidade, `propria: true`). `null` = nenhuma
 * unidade configurada usa essa conta: RECUSAR.
 */
export function donaDaConta(ctx: ContextoChatwoot, contaId: number, e: NodeJS.ProcessEnv = process.env): { slug: string | null; ctx: ContextoChatwoot; propria: boolean } | null {
  if (ctx.conta && ehContaDoAmbiente(contaId, e) && ctx.conta.conta === contaId) return { slug: null, ctx, propria: true };
  let reserva: { slug: string; ctx: ContextoChatwoot; propria: boolean } | null = null;
  for (const slug of unidadesDaConta(contaId)) {
    const c = contextoDaUnidade(ctx, slug, e);
    if (!c) continue;
    const propria = temTokenProprio(slug, e);
    if (propria) return { slug, ctx: c, propria };
    reserva ??= { slug, ctx: c, propria };
  }
  return reserva;
}

/** O contexto de uma CONTA pelo id (o do evento que chegou). `null` = nenhuma unidade configurada usa essa conta (RECUSAR). */
export function contextoDaContaPorId(ctx: ContextoChatwoot, contaId: number, e: NodeJS.ProcessEnv = process.env): ContextoChatwoot | null {
  return donaDaConta(ctx, contaId, e)?.ctx ?? null;
}

/** O contexto da conta da CAIXA (pela unidade dona), ou `null` para caixa que nenhuma unidade configurada tem (RECUSAR). */
export function contextoDaCaixa(ctx: ContextoChatwoot, caixa: number, e: NodeJS.ProcessEnv = process.env): ContextoChatwoot | null {
  const slug = unidadeDaCaixa(caixa);
  return slug ? contextoDaUnidade(ctx, slug, e) : null;
}

/**
 * Caminho relativo à conta, limpo: "conversations/12/messages" ou "/inboxes". Recusa `..`, `//`, protocolo, query no caminho
 * (vai em `query`), caractere fora do comum e segmento vazio. "" = a própria conta.
 */
export function caminhoSeguro(bruto: unknown): string {
  const s = String(bruto ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (s === '') return '';
  if (/[?#]/.test(s)) throw new ErroDeEntrada('filtros vão em "query", não no caminho');
  if (!/^[A-Za-z0-9_\-./]+$/.test(s)) throw new ErroDeEntrada(`caminho inválido: "${s}"`);
  const partes = s.split('/');
  if (partes.some((p) => p === '' || p === '.' || p === '..')) throw new ErroDeEntrada(`caminho inválido: "${s}"`);
  if (/^(api|platform|super_admin|auth|accounts)\b/i.test(s)) throw new ErroDeEntrada('use o caminho relativo à conta (ex. "inboxes", "conversations/12") — sair da conta não existe aqui');
  return s;
}

/** Por que esta chamada precisa de dois passos, ou null (é direta). */
export function precisaConfirmar(metodo: Metodo, caminho: string, corpo?: Record<string, unknown>): string | null {
  if (metodo === 'DELETE') return 'apaga';
  if (metodo !== 'POST') return null;
  // mensagem numa conversa: só a nota privada (private: true) é direta; a pública chega ao cliente
  if (/^conversations\/\d+\/messages$/.test(caminho) && corpo?.private !== true) return 'manda mensagem ao cliente';
  // conversa nova com mensagem inicial também manda
  if (caminho === 'conversations' && corpo && corpo.message !== undefined && corpo.message !== null) return 'abre conversa mandando mensagem ao cliente';
  if (/^campaigns$/.test(caminho)) return 'cria campanha (manda mensagem a vários contatos)';
  return null;
}

/** Login de uma pessoa no Chatwoot (devise_token_auth): com ele a chamada vale com as permissões DELA (caixas, papel), não as do token. */
export interface SessaoDoChatwoot {
  token: string;
  client: string;
  uid: string;
}

export async function chamar(
  ctx: ContextoChatwoot,
  metodo: Metodo,
  caminhoBruto: string,
  o: { corpo?: unknown; query?: Record<string, string>; sessao?: SessaoDoChatwoot | null } = {},
): Promise<unknown> {
  const conta = ctx.conta;
  if (!conta) throw new ErroDeEntrada('o Chatwoot não está ligado neste conector');
  const caminho = caminhoSeguro(caminhoBruto);
  const qs = o.query && Object.keys(o.query).length ? `?${new URLSearchParams(o.query)}` : '';
  const url = `${conta.url}/api/v1/accounts/${conta.conta}${caminho ? `/${caminho}` : ''}${qs}`;
  const r = await ctx.fetch(url, {
    method: metodo,
    headers: o.sessao
      ? { 'access-token': o.sessao.token, client: o.sessao.client, uid: o.sessao.uid, 'token-type': 'Bearer', 'Content-Type': 'application/json', Accept: 'application/json' }
      : { api_access_token: conta.token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: metodo === 'GET' || metodo === 'DELETE' ? undefined : JSON.stringify(o.corpo ?? {}),
    signal: AbortSignal.timeout(60_000),
  });
  const texto = await r.text();
  let dados: unknown;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = texto;
  }
  if (!r.ok) {
    const d = dados as { message?: unknown; error?: unknown; errors?: unknown } | null;
    const msg = d && typeof d === 'object' ? (d.message ?? d.error ?? d.errors ?? d) : d;
    let txt = JSON.stringify(msg).slice(0, 400).split(conta.token).join('***');
    if (o.sessao) txt = txt.split(o.sessao.token).join('***');
    const erro = new Error(`Chatwoot ${r.status} em ${metodo} ${caminho || '(conta)'}: ${txt}`) as Error & { status?: number };
    erro.status = r.status;
    throw erro;
  }
  return dados ?? { ok: true };
}

/** Chamada direta: recusa o que precisa de dois passos, apontando o caminho certo. */
export function chamarDireto(ctx: ContextoChatwoot, metodo: Metodo, caminho: string, corpo?: Record<string, unknown>, query?: Record<string, string>) {
  const c = caminhoSeguro(caminho);
  const motivo = precisaConfirmar(metodo, c, corpo);
  if (motivo) throw new ErroDeEntrada(`isto ${motivo}: use chatwoot_preparar e, com o ok da pessoa, chatwoot_confirmar`);
  return chamar(ctx, metodo, c, { corpo, query });
}

export function preparar(ctx: ContextoChatwoot, usuario: string, a: { metodo: Metodo; caminho: string; corpo?: Record<string, unknown>; query?: Record<string, string> }) {
  const caminho = caminhoSeguro(a.caminho);
  const motivo = precisaConfirmar(a.metodo, caminho, a.corpo) ?? 'confirmação pedida';
  for (const [k, v] of ctx.pendentes) if (ctx.agora() - v.criadoEm > VALIDADE_MS) ctx.pendentes.delete(k);
  let codigo: string;
  do codigo = randomBytes(6).toString('hex').toUpperCase();
  while (ctx.pendentes.has(codigo));
  ctx.pendentes.set(codigo, { usuario, acao: { metodo: a.metodo, caminho, corpo: a.corpo, query: a.query, motivo }, criadoEm: ctx.agora() });
  return {
    codigo,
    validoPor: `${VALIDADE_MS / 60_000} min`,
    vaiFazer: `${a.metodo} ${caminho || '(conta)'} — ${motivo}`,
    dados: { ...(a.corpo ?? {}), ...(a.query ?? {}) },
    proximoPasso: 'mostre isto à pessoa; só com o ok dela chame chatwoot_confirmar com o código',
  };
}

export async function confirmar(ctx: ContextoChatwoot, usuario: string, codigoBruto: string): Promise<unknown> {
  const codigo = codigoBruto.trim().toUpperCase();
  const p = ctx.pendentes.get(codigo);
  if (!p) throw new ErroDeEntrada('código desconhecido ou já usado — prepare de novo');
  if (p.usuario !== usuario) throw new ErroDeEntrada('este código foi gerado por outro usuário');
  ctx.pendentes.delete(codigo);
  if (ctx.agora() - p.criadoEm > VALIDADE_MS) throw new ErroDeEntrada(`o código venceu (${VALIDADE_MS / 60_000} min) — prepare de novo`);
  const r = await chamar(ctx, p.acao.metodo, p.acao.caminho, { corpo: p.acao.corpo, query: p.acao.query });
  if (p.acao.metodo === 'DELETE') {
    try {
      await ctx.avisar(`🗑️ Chatwoot: ${usuario} apagou ${p.acao.caminho} pelo conector do claude.ai`);
    } catch {
      // aviso que falha não desfaz nem esconde o que foi feito
    }
  }
  return r;
}

const ler = { readOnlyHint: true, openWorldHint: true } as const;
const escrever = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const pagina = z.number().int().min(1).max(500).optional();
const metodo = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const corpo = z.record(z.string(), z.unknown()).optional();
const query = z.record(z.string(), z.string()).optional();

export function registrarFerramentasChatwoot(server: McpServer, ctx: ContextoChatwoot, usuario: string, auditar: Auditar): void {
  if (!ctx.conta) return;
  const reg = <S extends z.ZodRawShape>(id: string, titulo: string, descricao: string, schema: S, anot: object, fn: (a: z.objectOutputType<S, z.ZodTypeAny>) => unknown) =>
    server.registerTool(id, { title: titulo, description: descricao, inputSchema: schema, annotations: anot }, ((a: any) => executar(id, a, auditar, () => fn(a))) as any);

  reg('chatwoot_conta', 'Chatwoot: a conta', 'Dados da conta do Chatwoot (atendimento.doutordigitalconsultoria.com): nome, idioma, recursos ligados.', {}, ler, () => chamar(ctx, 'GET', ''));
  reg(
    'chatwoot_conversas',
    'Chatwoot: conversas',
    'Conversas do Chatwoot. status: open | resolved | pending | snoozed | all (padrão open). Filtra por caixa (inboxId), etiqueta, responsável (assigneeType: me | unassigned | all | assigned) e página (25 por página).',
    {
      status: z.enum(['open', 'resolved', 'pending', 'snoozed', 'all']).optional(),
      inboxId: z.number().int().optional(),
      etiqueta: z.string().optional(),
      assigneeType: z.enum(['me', 'unassigned', 'all', 'assigned']).optional(),
      pagina,
    },
    ler,
    (a) => {
      const q: Record<string, string> = { status: a.status ?? 'open', assignee_type: a.assigneeType ?? 'all', page: String(a.pagina ?? 1) };
      if (a.inboxId) q.inbox_id = String(a.inboxId);
      if (a.etiqueta) q['labels[]'] = a.etiqueta;
      return chamar(ctx, 'GET', 'conversations', { query: q });
    },
  );
  reg(
    'chatwoot_mensagens',
    'Chatwoot: mensagens de uma conversa',
    'Mensagens de UMA conversa (id da conversa em chatwoot_conversas).',
    { conversaId: z.number().int().positive() },
    ler,
    (a) => chamar(ctx, 'GET', `conversations/${a.conversaId}/messages`),
  );
  reg(
    'chatwoot_contatos',
    'Chatwoot: contatos',
    'Contatos. Com "busca", procura por nome, e-mail ou telefone; sem, lista por página.',
    { busca: z.string().optional(), pagina },
    ler,
    (a) =>
      a.busca?.trim()
        ? chamar(ctx, 'GET', 'contacts/search', { query: { q: a.busca.trim(), page: String(a.pagina ?? 1) } })
        : chamar(ctx, 'GET', 'contacts', { query: { page: String(a.pagina ?? 1) } }),
  );
  reg('chatwoot_caixas', 'Chatwoot: caixas de entrada', 'Caixas de entrada (WhatsApp, site, e-mail, API) com id e canal.', {}, ler, () => chamar(ctx, 'GET', 'inboxes'));
  reg('chatwoot_etiquetas', 'Chatwoot: etiquetas', 'Etiquetas da conta.', {}, ler, () => chamar(ctx, 'GET', 'labels'));
  reg('chatwoot_agentes', 'Chatwoot: agentes', 'Agentes (pessoas da equipe) com papel e disponibilidade.', {}, ler, () => chamar(ctx, 'GET', 'agents'));
  reg('chatwoot_equipes', 'Chatwoot: equipes', 'Equipes da conta.', {}, ler, () => chamar(ctx, 'GET', 'teams'));
  reg(
    'chatwoot_api',
    'Chatwoot: qualquer rota da conta',
    'Chama QUALQUER rota da API da conta do Chatwoot (developers.chatwoot.com, "Application APIs"), com o caminho RELATIVO à conta ' +
      '(ex. GET "automation_rules", POST "labels" {title, color}, POST "inboxes", PATCH "contacts/12", POST "conversations/5/labels" ' +
      '{labels:[…]}, POST "conversations/5/assignments" {assignee_id}, POST "conversations/5/toggle_status" {status}, POST "canned_responses", ' +
      'POST "custom_attribute_definitions", POST "agents", POST "teams", POST "conversations/5/messages" {content, private:true} para NOTA ' +
      'interna). Criar e alterar é direto. APAGAR e o que manda mensagem ao cliente (mensagem pública, conversa nova com mensagem, campanha) ' +
      'é recusado aqui: use chatwoot_preparar.',
    { metodo, caminho: z.string(), corpo, query },
    escrever,
    (a) => chamarDireto(ctx, a.metodo, a.caminho, a.corpo, a.query),
  );
  reg(
    'chatwoot_preparar',
    'Chatwoot: preparar ação sensível',
    'PASSO 1 de 2 para APAGAR algo ou MANDAR mensagem a cliente no Chatwoot: NÃO executa nada — devolve o resumo e um código. ' +
      'Mostre o resumo à pessoa e só chame chatwoot_confirmar se ela aprovar. Mesmo formato de chatwoot_api (metodo, caminho relativo à conta, corpo, query).',
    { metodo, caminho: z.string(), corpo, query },
    { readOnlyHint: true, openWorldHint: false },
    (a) => preparar(ctx, usuario, a),
  );
  reg(
    'chatwoot_confirmar',
    'Chatwoot: confirmar ação sensível',
    'PASSO 2 de 2: executa o que chatwoot_preparar montou. Só chame com o ok explícito da pessoa. O código vale 10 minutos e uma vez.',
    { codigo: z.string().min(6).max(16) },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (a) => confirmar(ctx, usuario, a.codigo),
  );
}
