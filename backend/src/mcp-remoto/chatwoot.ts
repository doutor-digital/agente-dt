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

export async function chamar(ctx: ContextoChatwoot, metodo: Metodo, caminhoBruto: string, o: { corpo?: unknown; query?: Record<string, string> } = {}): Promise<unknown> {
  const conta = ctx.conta;
  if (!conta) throw new ErroDeEntrada('o Chatwoot não está ligado neste conector');
  const caminho = caminhoSeguro(caminhoBruto);
  const qs = o.query && Object.keys(o.query).length ? `?${new URLSearchParams(o.query)}` : '';
  const url = `${conta.url}/api/v1/accounts/${conta.conta}${caminho ? `/${caminho}` : ''}${qs}`;
  const r = await ctx.fetch(url, {
    method: metodo,
    headers: { api_access_token: conta.token, 'Content-Type': 'application/json', Accept: 'application/json' },
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
    throw new Error(`Chatwoot ${r.status} em ${metodo} ${caminho || '(conta)'}: ${JSON.stringify(msg).slice(0, 400).split(conta.token).join('***')}`);
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
