/**
 * WhatsApp de UM número pelo claude.ai (Evolution API) — hoje o da Suzanne, instância "Suzanne - Relatorios" (22/10/2026).
 *
 * Só para quem está em MCP_EVOLUTION_EMAILS: é o WhatsApp pessoal dela, não dado da clínica. Usa o token DA INSTÂNCIA,
 * não a chave global — o conector não enxerga nem mexe no número dos relatórios (alertas2) nem em outro.
 *
 * Ler e organizar (marcar lida, arquivar, etiquetar) é direto. Mandar mensagem e mexer em grupo é em DOIS passos, como a
 * escrita do Kommo: `evo_preparar` mostra o que vai sair e devolve um código preso a quem pediu; `evo_confirmar` executa.
 * Freio anti-ban nos envios (o 9119 foi banido em 06/10 por rajada em horário fixo): teto por hora e por dia, "digitando"
 * de 1,2–3 s e silêncio das 21h às 7h. Apagar/desconectar o número e trocar o webhook não existem aqui.
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';

/** Nome do registro de cada mensagem que saiu, na auditoria do conector — a produção relê para o teto. */
export const EVENTO_DE_ENVIO = 'evo_envio';
export const LIMITES_EVOLUTION = { porHora: 20, porDia: 100, horaInicio: 7, horaFim: 21, validadeMs: 10 * 60_000, gruposMs: 30 * 60_000, esperaGruposMs: 40_000 };
const FUSO = 'America/Sao_Paulo';

export interface ContaEvolution {
  url: string;
  instancia: string;
  chave: string;
}

type Acao = { metodo: 'GET' | 'POST'; caminho: string; corpo?: Record<string, unknown>; query?: Record<string, string>; envio: boolean };
type Grupo = { grupo: string; nome: string; membros: number | null };

export interface ContextoEvolution {
  conta: ContaEvolution | null;
  fetch: typeof fetch;
  agora: () => number;
  pendentes: Map<string, { usuario: string; acao: Acao; criadoEm: number }>;
  envios: number[];
  grupos: { em: number; lista: Grupo[] } | null;
  gruposCarregando: Promise<Grupo[]> | null;
  fila: Promise<unknown>;
  /** Envios das últimas 24 h feitos antes desta subida do servidor (auditoria). Sem carregar, nada sai. */
  historico: { pronto: boolean; carregar?: () => Promise<number[]> };
}

export function criarContextoEvolution(
  conta: ContaEvolution | null,
  o: { fetch?: typeof fetch; agora?: () => number; historico?: () => Promise<number[]> } = {},
): ContextoEvolution {
  return {
    conta,
    fetch: o.fetch ?? globalThis.fetch,
    agora: o.agora ?? Date.now,
    pendentes: new Map(),
    envios: [],
    grupos: null,
    gruposCarregando: null,
    fila: Promise.resolve(),
    historico: { pronto: !o.historico, carregar: o.historico },
  };
}

/** O teto anti-ban conta também o que saiu antes do reinício: até ler isso, nenhum envio passa (achado do Codex). */
async function garantirHistorico(ctx: ContextoEvolution): Promise<void> {
  if (ctx.historico.pronto || !ctx.historico.carregar) return;
  try {
    ctx.envios.push(...(await ctx.historico.carregar()));
    ctx.historico.pronto = true;
  } catch {
    throw new ErroDeEntrada('não consegui conferir os envios recentes (teto anti-ban) — nada foi enviado; tente em instantes');
  }
}

/** Lê a conta do ambiente; sem as três variáveis, null (as ferramentas nem aparecem). */
export function contaEvolutionDoAmbiente(e: NodeJS.ProcessEnv = process.env): ContaEvolution | null {
  const instancia = e.MCP_EVOLUTION_INSTANCIA?.trim();
  const chave = e.MCP_EVOLUTION_TOKEN?.trim();
  if (!instancia || !chave) return null;
  return { url: (e.MCP_EVOLUTION_URL?.trim() || 'https://evolution.doutordigitalconsultoria.com').replace(/\/+$/, ''), instancia, chave };
}

/** "+55 63 8141-1248" → "556381411248"; JID de grupo/contato passa como está. */
const JID_VALIDO = /^(\d{8,20}@s\.whatsapp\.net|\d{10,30}(-\d{1,15})?@g\.us|\d{6,25}@lid)$/;

export function normalizarNumero(bruto: unknown): string {
  const s = String(bruto ?? '').trim();
  if (s.includes('@')) {
    // JID só no formato do WhatsApp: um erro de digitação não pode virar destino (achado do Codex)
    if (!JID_VALIDO.test(s)) throw new ErroDeEntrada(`JID inválido: "${s}" (grupo termina em @g.us, contato em @s.whatsapp.net)`);
    return s;
  }
  const d = s.replace(/\D/g, '');
  if (d.length < 10) throw new ErroDeEntrada(`número inválido: "${s}" (use DDD+número, ex. 63 98141-1248)`);
  return d.length <= 11 ? `55${d}` : d;
}

async function chamar(ctx: ContextoEvolution, metodo: 'GET' | 'POST', caminho: string, o: { corpo?: unknown; query?: Record<string, string> } = {}): Promise<unknown> {
  const conta = ctx.conta;
  if (!conta) throw new ErroDeEntrada('o WhatsApp não está ligado neste conector');
  const qs = o.query ? `?${new URLSearchParams(o.query)}` : '';
  const r = await ctx.fetch(`${conta.url}${caminho}/${encodeURIComponent(conta.instancia)}${qs}`, {
    method: metodo,
    headers: { apikey: conta.chave, 'Content-Type': 'application/json' },
    body: metodo === 'GET' ? undefined : JSON.stringify(o.corpo ?? {}),
    signal: AbortSignal.timeout(150_000),
  });
  const texto = await r.text();
  let dados: unknown;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = texto;
  }
  if (!r.ok) {
    const d = dados as { response?: unknown; message?: unknown } | null;
    throw new Error(`WhatsApp (Evolution) ${r.status} em ${caminho}: ${JSON.stringify(d?.response ?? d?.message ?? d).slice(0, 300)}`);
  }
  return dados;
}

/** Rotas que nunca passam: apagam/desconectam o número ou desviam as mensagens dele. */
const ROTAS_PROIBIDAS = /^\/(instance\/(delete|logout|restart|create|setPresence)|webhook\/set|websocket\/set|rabbitmq\/set|sqs\/set|settings\/set|proxy\/set|chatwoot\/set|typebot|openai|dify|flowise|evolutionBot|n8n|evoai)/i;
/** Leitura avulsa: o caminho INTEIRO (sem ".." nem segmento a mais); o método sai da rota, não de quem chama. */
const ROTA_DE_LEITURA = /^\/(chat\/(find|fetch)[A-Za-z]*|chat\/(whatsappNumbers|getBase64FromMediaMessage)|group\/(fetchAllGroups|findGroupInfos|participants|inviteCode|inviteInfo)|label\/findLabels|instance\/connectionState|settings\/find|webhook\/find|business\/(getCatalog|getCollections))$/i;

export function rotaDeLeitura(ctx: ContextoEvolution, caminho: string, corpo?: Record<string, unknown>, query?: Record<string, string>) {
  const c = `/${String(caminho).replace(/^\/+/, '').replace(/\/+$/, '')}`;
  if (ROTAS_PROIBIDAS.test(c)) throw new ErroDeEntrada(`rota bloqueada: ${c}`);
  if (!ROTA_DE_LEITURA.test(c)) throw new ErroDeEntrada(`só rota de leitura aqui (find/fetch/…); envio e alteração passam por evo_preparar — ${c}`);
  const metodo = /^\/(chat|business)\//i.test(c) ? 'POST' : 'GET';
  return chamar(ctx, metodo, c, { corpo: metodo === 'POST' ? corpo : undefined, query });
}

type MsgCrua = { key?: { id?: string; fromMe?: boolean; remoteJid?: string; participant?: string }; pushName?: string; messageTimestamp?: number | string; messageType?: string; message?: Record<string, any> };

function textoDa(m: MsgCrua | undefined | null): string | null {
  const msg = m?.message ?? {};
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.fileName ??
    (m?.messageType ? `[${m.messageType}]` : null)
  );
}
const quando = (ts: unknown) => (ts ? new Date(Number(ts) * (String(ts).length > 10 ? 1 : 1000)).toISOString() : null);
const casa = (busca: string | undefined, ...campos: unknown[]) => !busca || campos.some((c) => String(c ?? '').toLowerCase().includes(busca.toLowerCase()));

export async function conversas(ctx: ContextoEvolution, a: { busca?: string; limite?: number; soNaoLidas?: boolean }) {
  const lista = await chamar(ctx, 'POST', '/chat/findChats', { corpo: {} });
  return (Array.isArray(lista) ? lista : [])
    .map((c: any) => ({
      conversa: c.remoteJid ?? c.id,
      nome: c.pushName ?? c.name ?? null,
      naoLidas: c.unreadCount ?? 0,
      atualizada: c.updatedAt ?? null,
      ultima: textoDa(c.lastMessage),
      ultimaId: c.lastMessage?.key?.id ?? null,
      ultimaMinha: c.lastMessage?.key?.fromMe ?? null,
    }))
    .filter((c) => casa(a.busca, c.nome, c.conversa) && (!a.soNaoLidas || c.naoLidas > 0))
    .sort((x, y) => String(y.atualizada).localeCompare(String(x.atualizada)))
    .slice(0, a.limite ?? 30);
}

export async function mensagens(ctx: ContextoEvolution, a: { conversa: string; pagina?: number; porPagina?: number }) {
  const r = (await chamar(ctx, 'POST', '/chat/findMessages', {
    corpo: { where: { key: { remoteJid: normalizarNumero(a.conversa) } }, page: a.pagina ?? 1, offset: a.porPagina ?? 30 },
  })) as any;
  const m = r?.messages ?? r;
  return {
    total: m?.total ?? null,
    paginas: m?.pages ?? null,
    pagina: m?.currentPage ?? a.pagina ?? 1,
    mensagens: ((m?.records ?? []) as MsgCrua[]).map((x) => ({
      id: x.key?.id,
      deMim: x.key?.fromMe,
      quem: x.pushName ?? null,
      participante: x.key?.participant ?? null,
      quando: quando(x.messageTimestamp),
      tipo: x.messageType,
      texto: textoDa(x),
    })),
  };
}

/**
 * Grupos: o WhatsApp monta a lista na hora e leva 1–2 min com centenas de grupos (385 no número da Suzanne). A lista fica
 * guardada 30 min; enquanto carrega, quem pede espera até 40 s e depois ouve "tente em 1 minuto" — a busca segue.
 */
export async function grupos(ctx: ContextoEvolution, a: { busca?: string; limite?: number }) {
  const fresco = ctx.grupos && ctx.agora() - ctx.grupos.em < LIMITES_EVOLUTION.gruposMs ? ctx.grupos.lista : null;
  let lista = fresco;
  if (!lista) {
    if (!ctx.gruposCarregando) {
      ctx.gruposCarregando = chamar(ctx, 'GET', '/group/fetchAllGroups', { query: { getParticipants: 'false' } })
        .then((r) => {
          const l = (Array.isArray(r) ? r : []).map((g: any) => ({ grupo: g.id, nome: g.subject, membros: g.size ?? null }));
          ctx.grupos = { em: ctx.agora(), lista: l };
          return l;
        })
        .finally(() => {
          ctx.gruposCarregando = null;
        });
      ctx.gruposCarregando.catch(() => undefined);
    }
    let timer: NodeJS.Timeout | undefined;
    const espera = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), LIMITES_EVOLUTION.esperaGruposMs);
      timer.unref?.();
    });
    lista = await Promise.race([ctx.gruposCarregando, espera]).finally(() => clearTimeout(timer));
    if (!lista) throw new ErroDeEntrada('o WhatsApp ainda está montando a lista de grupos (leva 1–2 min) — peça de novo em 1 minuto');
  }
  const achados = lista.filter((g) => casa(a.busca, g.nome, g.grupo)).sort((x, y) => String(x.nome).localeCompare(String(y.nome)));
  const limite = a.limite ?? 100;
  return { total: achados.length, mostrando: Math.min(limite, achados.length), grupos: achados.slice(0, limite) };
}

/**
 * Link de mídia: o Evolution baixa ele do servidor, então só https público — nada de localhost, rede interna ou o
 * endereço de metadados da nuvem (achado do Codex).
 */
export function urlPublica(bruta: unknown): string {
  let u: URL;
  try {
    u = new URL(String(bruta ?? ''));
  } catch {
    throw new ErroDeEntrada(`link inválido: ${String(bruta)}`);
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const interno =
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    !h.includes('.') ||
    /^(127|10|0)\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^(::1?|f[cd][0-9a-f]{2}:.*|fe80:.*)$/.test(h);
  if (u.protocol !== 'https:' || interno) throw new ErroDeEntrada(`só link https público: ${u.protocol}//${u.hostname}`);
  return u.toString();
}

/** O que cada tipo de ação faz na API — o preparar valida, o confirmar executa. */
export function montarAcao(tipo: string, a: Record<string, any>): Acao {
  const para = () => normalizarNumero(a.para);
  switch (tipo) {
    case 'texto':
      if (!String(a.texto ?? '').trim()) throw new ErroDeEntrada('texto vazio');
      return { metodo: 'POST', caminho: '/message/sendText', corpo: { number: para(), text: a.texto }, envio: true };
    case 'midia':
      if (!a.url) throw new ErroDeEntrada('falta a url da mídia');
      return {
        metodo: 'POST',
        caminho: '/message/sendMedia',
        corpo: { number: para(), mediatype: a.tipoMidia ?? 'image', media: urlPublica(a.url), caption: a.texto ?? '', fileName: a.nomeArquivo },
        envio: true,
      };
    case 'audio':
      if (!a.url) throw new ErroDeEntrada('falta a url do áudio');
      return { metodo: 'POST', caminho: '/message/sendWhatsAppAudio', corpo: { number: para(), audio: urlPublica(a.url) }, envio: true };
    case 'localizacao':
      if (a.latitude == null || a.longitude == null) throw new ErroDeEntrada('falta latitude/longitude');
      return {
        metodo: 'POST',
        caminho: '/message/sendLocation',
        corpo: { number: para(), name: a.nome ?? '', address: a.endereco ?? '', latitude: a.latitude, longitude: a.longitude },
        envio: true,
      };
    case 'reacao':
      if (!a.mensagemId || !a.conversa) throw new ErroDeEntrada('falta mensagemId/conversa');
      return {
        metodo: 'POST',
        caminho: '/message/sendReaction',
        corpo: { key: { remoteJid: normalizarNumero(a.conversa), fromMe: !!a.minha, id: a.mensagemId }, reaction: a.texto ?? '👍' },
        envio: true,
      };
    case 'grupo_criar':
      if (!a.assunto || !a.participantes?.length) throw new ErroDeEntrada('falta assunto/participantes');
      return { metodo: 'POST', caminho: '/group/create', corpo: { subject: a.assunto, description: a.texto ?? '', participants: a.participantes.map(normalizarNumero) }, envio: false };
    case 'grupo_participantes':
      if (!a.grupo || !a.participantes?.length || !a.acao) throw new ErroDeEntrada('falta grupo/participantes/acao');
      if (!['add', 'remove', 'promote', 'demote'].includes(a.acao)) throw new ErroDeEntrada(`ação de grupo inválida: ${a.acao}`);
      return { metodo: 'POST', caminho: '/group/updateParticipant', query: { groupJid: normalizarNumero(a.grupo) }, corpo: { action: a.acao, participants: a.participantes.map(normalizarNumero) }, envio: false };
    case 'grupo_assunto':
      if (!a.grupo || !a.assunto) throw new ErroDeEntrada('falta grupo/assunto');
      return { metodo: 'POST', caminho: '/group/updateGroupSubject', query: { groupJid: normalizarNumero(a.grupo) }, corpo: { subject: a.assunto }, envio: false };
    case 'grupo_descricao':
      if (!a.grupo) throw new ErroDeEntrada('falta grupo');
      return { metodo: 'POST', caminho: '/group/updateGroupDescription', query: { groupJid: normalizarNumero(a.grupo) }, corpo: { description: a.texto ?? '' }, envio: false };
    default:
      throw new ErroDeEntrada(`tipo desconhecido: ${tipo}`);
  }
}

function horaLocal(ms: number): number {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: FUSO }).format(new Date(ms)));
}

/** Por que não dá pra mandar agora (anti-ban), ou null. */
export function freio(ctx: ContextoEvolution): string | null {
  const t = ctx.agora();
  const h = horaLocal(t);
  const L = LIMITES_EVOLUTION;
  if (h < L.horaInicio || h >= L.horaFim) return `silêncio das ${L.horaFim}h às ${L.horaInicio}h (anti-ban) — confirme de novo depois das ${L.horaInicio}h`;
  ctx.envios = ctx.envios.filter((e) => t - e < 86_400_000);
  if (ctx.envios.filter((e) => t - e < 3_600_000).length >= L.porHora) return `limite de ${L.porHora} envios por hora (anti-ban)`;
  if (ctx.envios.length >= L.porDia) return `limite de ${L.porDia} envios por dia (anti-ban)`;
  return null;
}

export function preparar(ctx: ContextoEvolution, usuario: string, tipo: string, args: Record<string, unknown>) {
  const acao = montarAcao(tipo, args);
  for (const [k, v] of ctx.pendentes) if (ctx.agora() - v.criadoEm > LIMITES_EVOLUTION.validadeMs) ctx.pendentes.delete(k);
  // código que nunca repete entre os pendentes: colisão trocaria uma ação (e o destinatário) por outra
  let codigo: string;
  do codigo = randomBytes(6).toString('hex').toUpperCase();
  while (ctx.pendentes.has(codigo));
  ctx.pendentes.set(codigo, { usuario, acao, criadoEm: ctx.agora() });
  const aviso = acao.envio ? freio(ctx) : null;
  return {
    codigo,
    validoPor: `${LIMITES_EVOLUTION.validadeMs / 60_000} min`,
    vaiFazer: `${acao.metodo} ${acao.caminho}`,
    dados: { ...acao.corpo, ...(acao.query ?? {}) },
    aviso: aviso ? `AGORA NÃO SAI: ${aviso}` : null,
    proximoPasso: 'mostre isto à pessoa; só com o ok dela chame evo_confirmar com o código',
  };
}

/**
 * Em fila: duas confirmações juntas passariam as duas pelo freio antes de qualquer uma ser contada. `aoEnviar` grava o
 * envio fora do processo (auditoria), para o teto sobreviver a um reinício — ver `enviosRecentes` na produção.
 */
export function confirmar(ctx: ContextoEvolution, usuario: string, codigo: string, aoEnviar?: (para: unknown) => void): Promise<unknown> {
  const vez = ctx.fila.then(() => confirmarAgora(ctx, usuario, codigo, aoEnviar));
  ctx.fila = vez.catch(() => undefined);
  return vez;
}

async function confirmarAgora(ctx: ContextoEvolution, usuario: string, codigoBruto: string, aoEnviar?: (para: unknown) => void): Promise<unknown> {
  const codigo = codigoBruto.trim().toUpperCase();
  const p = ctx.pendentes.get(codigo);
  if (!p) throw new ErroDeEntrada('código desconhecido ou já usado — prepare de novo');
  if (p.usuario !== usuario) throw new ErroDeEntrada('este código foi gerado por outro usuário');
  ctx.pendentes.delete(codigo);
  if (ctx.agora() - p.criadoEm > LIMITES_EVOLUTION.validadeMs) throw new ErroDeEntrada(`o código venceu (${LIMITES_EVOLUTION.validadeMs / 60_000} min) — prepare de novo`);
  if (p.acao.envio) {
    await garantirHistorico(ctx);
    const motivo = freio(ctx);
    if (motivo) throw new ErroDeEntrada(`não enviado: ${motivo}`);
    // "digitando…" de 1,2 a 3 s antes de sair: rajada idêntica foi o que derrubou o 9119
    p.acao.corpo = { ...p.acao.corpo, delay: 1200 + Math.floor(Math.random() * 1800) };
  }
  // conta ANTES de chamar: resposta perdida com a mensagem já entregue não pode liberar uma 2ª (achado do Codex)
  if (p.acao.envio) {
    ctx.envios.push(ctx.agora());
    aoEnviar?.(p.acao.corpo?.number);
  }
  return chamar(ctx, p.acao.metodo, p.acao.caminho, { corpo: p.acao.corpo, query: p.acao.query });
}

const ler = { readOnlyHint: true, openWorldHint: true } as const;
const organizar = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registrarFerramentasEvolution(server: McpServer, ctx: ContextoEvolution, usuario: string, auditar: Auditar): void {
  if (!ctx.conta) return;
  const nome = ctx.conta.instancia;
  const reg = <S extends z.ZodRawShape>(id: string, titulo: string, descricao: string, schema: S, anot: object, fn: (a: z.objectOutputType<S, z.ZodTypeAny>) => unknown) =>
    server.registerTool(id, { title: titulo, description: descricao, inputSchema: schema, annotations: anot }, ((a: any) => executar(id, a, auditar, () => fn(a))) as any);

  reg('evo_estado', `WhatsApp ${nome}: conexão`, `Estado da conexão do WhatsApp "${nome}" (open = conectado).`, {}, ler, () => chamar(ctx, 'GET', '/instance/connectionState'));
  reg(
    'evo_conversas',
    `WhatsApp ${nome}: conversas`,
    `Conversas do WhatsApp "${nome}", mais recentes primeiro, com a última mensagem. "busca" filtra por nome ou número.`,
    { busca: z.string().optional(), limite: z.number().int().min(1).max(200).optional(), soNaoLidas: z.boolean().optional() },
    ler,
    (a) => conversas(ctx, a),
  );
  reg(
    'evo_mensagens',
    `WhatsApp ${nome}: mensagens`,
    'Mensagens de UMA conversa (número, ou JID de grupo ...@g.us), paginadas: id, de quem, quando e o texto.',
    { conversa: z.string().min(3), pagina: z.number().int().min(1).optional(), porPagina: z.number().int().min(1).max(100).optional() },
    ler,
    (a) => mensagens(ctx, a),
  );
  reg(
    'evo_contatos',
    `WhatsApp ${nome}: contatos`,
    'Contatos do número. "busca" filtra por nome ou número.',
    { busca: z.string().optional(), limite: z.number().int().min(1).max(500).optional() },
    ler,
    async (a) => {
      const lista = await chamar(ctx, 'POST', '/chat/findContacts', { corpo: { where: {} } });
      return (Array.isArray(lista) ? lista : [])
        .map((c: any) => ({ contato: c.remoteJid ?? c.id, nome: c.pushName ?? null }))
        .filter((c) => casa(a.busca, c.nome, c.contato))
        .slice(0, a.limite ?? 50);
    },
  );
  reg(
    'evo_grupos',
    `WhatsApp ${nome}: grupos`,
    'Grupos em que o número está (id ...@g.us, nome, membros). "busca" filtra pelo nome. A 1ª chamada demora (o WhatsApp monta a lista); se pedir pra tentar de novo, espere 1 minuto.',
    { busca: z.string().optional(), limite: z.number().int().min(1).max(500).optional() },
    ler,
    (a) => grupos(ctx, a),
  );
  reg(
    'evo_grupo',
    `WhatsApp ${nome}: um grupo`,
    'Detalhes de um grupo e os participantes (com quem é admin).',
    { grupo: z.string().min(5) },
    ler,
    async (a) => ({
      info: await chamar(ctx, 'GET', '/group/findGroupInfos', { query: { groupJid: normalizarNumero(a.grupo) } }),
      participantes: await chamar(ctx, 'GET', '/group/participants', { query: { groupJid: normalizarNumero(a.grupo) } }),
    }),
  );
  reg('evo_etiquetas', `WhatsApp ${nome}: etiquetas`, 'Etiquetas do WhatsApp Business do número (id, nome, cor).', {}, ler, () => chamar(ctx, 'GET', '/label/findLabels'));
  reg(
    'evo_tem_whatsapp',
    `WhatsApp ${nome}: confere números`,
    'Confere se números têm WhatsApp (e o JID certo de cada um).',
    { numeros: z.array(z.string()).min(1).max(50) },
    ler,
    (a) => chamar(ctx, 'POST', '/chat/whatsappNumbers', { corpo: { numbers: a.numeros.map(normalizarNumero) } }),
  );
  reg(
    'evo_chamar_rota',
    `WhatsApp ${nome}: rota de leitura`,
    'Rota de LEITURA do Evolution sem ferramenta própria (ex. /chat/findStatusMessage, /group/inviteCode, /settings/find). Envio, alteração e rotas perigosas são recusados.',
    { caminho: z.string().min(2), corpo: z.record(z.string(), z.unknown()).optional(), query: z.record(z.string(), z.string()).optional() },
    ler,
    (a) => rotaDeLeitura(ctx, a.caminho, a.corpo, a.query),
  );

  const chave = (conversa: string, mensagemId: string, minha?: boolean) => ({ remoteJid: normalizarNumero(conversa), fromMe: !!minha, id: mensagemId });
  reg(
    'evo_marcar_lida',
    `WhatsApp ${nome}: marcar como lida`,
    'Marca uma mensagem (e a conversa) como lida.',
    { conversa: z.string(), mensagemId: z.string(), minha: z.boolean().optional() },
    organizar,
    (a) => chamar(ctx, 'POST', '/chat/markMessageAsRead', { corpo: { readMessages: [chave(a.conversa, a.mensagemId, a.minha)] } }),
  );
  reg(
    'evo_arquivar',
    `WhatsApp ${nome}: arquivar conversa`,
    'Arquiva (ou desarquiva, arquivar=false) uma conversa. Precisa do id da última mensagem (em evo_conversas: ultimaId/ultimaMinha).',
    { conversa: z.string(), mensagemId: z.string(), arquivar: z.boolean().optional(), minha: z.boolean().optional() },
    organizar,
    (a) =>
      chamar(ctx, 'POST', '/chat/archiveChat', {
        corpo: { lastMessage: { key: chave(a.conversa, a.mensagemId, a.minha) }, chat: normalizarNumero(a.conversa), archive: a.arquivar ?? true },
      }),
  );
  reg(
    'evo_marcar_nao_lida',
    `WhatsApp ${nome}: marcar como não lida`,
    'Marca a conversa como não lida (pra lembrar de voltar nela).',
    { conversa: z.string(), mensagemId: z.string(), minha: z.boolean().optional() },
    organizar,
    (a) => chamar(ctx, 'POST', '/chat/markChatUnread', { corpo: { lastMessage: { key: chave(a.conversa, a.mensagemId, a.minha) }, chat: normalizarNumero(a.conversa) } }),
  );
  reg(
    'evo_etiquetar',
    `WhatsApp ${nome}: etiquetar contato`,
    'Põe ou tira uma etiqueta do WhatsApp Business num contato (ids em evo_etiquetas).',
    { numero: z.string(), etiquetaId: z.string(), acao: z.enum(['add', 'remove']) },
    organizar,
    (a) => chamar(ctx, 'POST', '/label/handleLabel', { corpo: { number: normalizarNumero(a.numero), labelId: a.etiquetaId, action: a.acao } }),
  );

  reg(
    'evo_preparar',
    `WhatsApp ${nome}: preparar envio`,
    'PASSO 1 de 2 para ENVIAR mensagem ou mexer em grupo: NÃO executa nada — devolve o resumo e um código. Mostre o resumo à pessoa e só ' +
      'chame evo_confirmar se ela aprovar. Tipos: texto, midia (url), audio (url), localizacao, reacao, grupo_criar, grupo_participantes ' +
      `(acao add/remove/promote/demote), grupo_assunto, grupo_descricao. Freio anti-ban: ${LIMITES_EVOLUTION.porHora}/hora, ${LIMITES_EVOLUTION.porDia}/dia, ` +
      `nada entre ${LIMITES_EVOLUTION.horaFim}h e ${LIMITES_EVOLUTION.horaInicio}h.`,
    {
      tipo: z.enum(['texto', 'midia', 'audio', 'localizacao', 'reacao', 'grupo_criar', 'grupo_participantes', 'grupo_assunto', 'grupo_descricao']),
      para: z.string().optional().describe('número ou JID do grupo (envios)'),
      texto: z.string().max(4000).optional().describe('texto, legenda, emoji da reação ou descrição do grupo'),
      url: z.string().url().optional(),
      tipoMidia: z.enum(['image', 'video', 'document']).optional(),
      nomeArquivo: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      nome: z.string().optional(),
      endereco: z.string().optional(),
      mensagemId: z.string().optional(),
      conversa: z.string().optional(),
      minha: z.boolean().optional(),
      grupo: z.string().optional(),
      assunto: z.string().optional(),
      participantes: z.array(z.string()).max(50).optional(),
      acao: z.enum(['add', 'remove', 'promote', 'demote']).optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    ({ tipo, ...args }) => preparar(ctx, usuario, tipo, args),
  );
  reg(
    'evo_confirmar',
    `WhatsApp ${nome}: confirmar envio`,
    'PASSO 2 de 2: executa o que evo_preparar montou. Só chame com o ok explícito da pessoa. O código vale 10 minutos e uma vez.',
    { codigo: z.string().min(6).max(16) },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (a) => confirmar(ctx, usuario, a.codigo, (para) => auditar({ ferramenta: EVENTO_DE_ENVIO, argumentos: { para }, ok: true, ms: 0 })),
  );
}
