/**
 * Conversões do Chatwoot para a Meta (`chatwoot-capi`, pedido do João, 13/11/2026): quem veio de anúncio «Clique para o WhatsApp»
 * e AGENDOU, COMPARECEU e FECHOU volta para a Meta pela Conversions API for Business Messaging, para o algoritmo buscar paciente
 * que fecha. No Kommo isso já existe (n8n, `capi_envios`); aqui é o mesmo para as conversas do Chatwoot (Parauapebas, caixa 3 = WhatsApp
 * oficial via Kapso).
 *
 * Os mesmos nomes de evento do Kommo (ver `mcp-remoto/meta-eventos.ts`): agendou = AddToCart, compareceu = InitiateCheckout,
 * fechou = Purchase (valor fixo, como no Kommo). Formato: https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging
 *
 * Como decide (tudo em cima da conversa, sem escrever NADA no Chatwoot):
 *  - Agendou: etapa «Agendado» ou «Confirmado». Compareceu: etapa «Compareceu» ou situação da consulta «Atendido». Fechou: etapa
 *    «Fechou» ou «Fechou tratamento» = sim.
 *  - Só conta a ENTRADA no estado: na 1ª varredura da caixa, tudo que já estava assim é «inicial» e nunca é mandado (senão ligar a
 *    automação despejaria o estoque antigo; a Meta ainda recusaria o que tem mais de 7 dias). O horário do evento é o da 1ª vez que o
 *    worker viu a conversa assim (varredura de 10 min). Passou de 7 dias sem ir (ex.: ficou em «só no papel» muito tempo): não vai.
 *  - O `ctwa_clid` vem da 1ª mensagem recebida que traz `content_attributes.referral` (lida uma vez e guardada). Sem ele (lead
 *    orgânico, ou anúncio em Status, que a Meta não identifica): não manda nada.
 *  - NUNCA REPETE: a linha `capi:<Evento>` de `chatwoot_regua_disparo` (UNIQUE conversa+regra+chave, sem migration) é gravada ANTES
 *    de chamar a Meta; duas cópias do servidor não mandam em dobro. A Meta NÃO deduplica este caminho (doc), então a nossa trava é a
 *    única. Resposta com erro da Meta desfaz a linha e tenta no próximo ciclo (até `MAX_TENTATIVAS`); tempo esgotado SEM resposta pode
 *    ter ido: fica marcado «incerto» e não repete (melhor um evento a menos que dois).
 *  - Falha de configuração (token recusado, sem permissão) ou da Meta fora do ar (5xx, limite, rede): para o ciclo da unidade, não
 *    gasta tentativa do evento e avisa. Sem token/dataset: não chama e avisa UMA vez.
 *  - SECO: só registra e loga «enviaria evento X para a conversa Y (anúncio Z)». Não chama a Meta nem para descobrir o dataset.
 *
 * Dataset e token: o dataset é o da WABA da caixa (`GET /{WABA}/dataset`, o mesmo que o rastreio do Kommo usa) ou
 * `META_DATASET_ID_<UNIDADE>`; o token é `META_ADS_TOKEN_<UNIDADE>` (o mesmo do rastreio no n8n) ou `META_CAPI_TOKEN_<UNIDADE>`.
 */
import { createHash } from 'node:crypto';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { conversaDoChatwoot, ehSim, type ConversaRegua } from './chatwoot-regua.js';

export const ID_CAPI = 'chatwoot-capi';

/** caixa → unidade e a WABA da caixa. Só caixa de WhatsApp OFICIAL (a do Evolution não tem anúncio nem WABA). */
export const CAIXAS_CAPI: Readonly<Record<number, { slug: string; waba: string }>> = {
  3: { slug: 'doutor-hernia-parauapebas', waba: '2146287749563217' },
};

const SWEEP_MS = Number(process.env.CHATWOOT_CAPI_SWEEP_MS) || 10 * 60_000;
const PRIMEIRA_VARREDURA_MS = 240_000;
const MAX_PAGINAS = 200;
const PAUSA_ENTRE_CHAMADAS_MS = 150;
/** A Meta aceita `event_time` até 7 dias atrás e recusa o pedido inteiro se passar; 1 h de folga. */
export const JANELA_DA_META_MS = 7 * 24 * 3600_000 - 3600_000;
export const MAX_TENTATIVAS = 8;
export const MAX_ENVIOS_POR_CICLO = 30;
export const MAX_BUSCAS_DE_CLIQUE_POR_CICLO = 40;
/** Páginas de 20 mensagens: 15 páginas = 300 mensagens para achar a primeira da conversa. */
const MAX_PAGINAS_DE_MENSAGENS = 15;
const VALOR_PADRAO_DO_FECHAMENTO = 3500;

// ── a decisão (pura) ───────────────────────────────────────────────────────────────────────────────

export type EventoCapi = 'AddToCart' | 'InitiateCheckout' | 'Purchase';
export const EVENTOS_CAPI: readonly EventoCapi[] = ['AddToCart', 'InitiateCheckout', 'Purchase'];
export const SIGNIFICADO_DO_EVENTO: Readonly<Record<EventoCapi, string>> = { AddToCart: 'agendou', InitiateCheckout: 'compareceu', Purchase: 'fechou tratamento' };

const normalizar = (v: unknown): string =>
  (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

/** Os eventos que a conversa JÁ alcançou, pelos atributos dela. */
export function eventosAlcancados(attrs: Record<string, unknown>): EventoCapi[] {
  const etapa = normalizar(attrs.etapa);
  const situacao = normalizar(attrs.situacao_consulta);
  const saida: EventoCapi[] = [];
  if (etapa === 'agendado' || etapa === 'confirmado') saida.push('AddToCart');
  if (etapa === 'compareceu' || situacao === 'atendido') saida.push('InitiateCheckout');
  if (etapa === 'fechou' || ehSim(attrs.fechou_tratamento)) saida.push('Purchase');
  return saida;
}

export interface CliqueDoAnuncio {
  ctwaClid: string;
  /** id do anúncio (`referral.source_id`) */
  anuncio: string | null;
}

/** A 1ª mensagem RECEBIDA com referral entre as mensagens cruas do Chatwoot (qualquer ordem). */
export function cliqueDasMensagens(mensagens: unknown[]): CliqueDoAnuncio | null {
  let melhor: { clique: CliqueDoAnuncio; quando: number; id: number } | null = null;
  for (const m of mensagens as any[]) {
    if (Number(m?.message_type) !== 0) continue; // 0 = recebida do paciente
    const ref = m?.content_attributes?.referral;
    const clid = typeof ref?.ctwa_clid === 'string' ? ref.ctwa_clid.trim() : '';
    if (!clid) continue;
    const quando = Number(m?.created_at) || 0;
    const id = Number(m?.id) || 0;
    if (!melhor || quando < melhor.quando || (quando === melhor.quando && id < melhor.id)) {
      const anuncio = ref.source_id !== undefined && ref.source_id !== null ? String(ref.source_id) : null;
      melhor = { clique: { ctwaClid: clid, anuncio }, quando, id };
    }
  }
  return melhor?.clique ?? null;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const soDigitos = (s: string) => s.replace(/\D/g, '');
/** fn/ln: minúsculas, sem acento nem pontuação (regra da Meta para dados de contato). */
const parteDoNome = (s: string) => normalizar(s).replace(/[^\p{L}\p{N}]/gu, '');

export interface EntradaDoEvento {
  evento: EventoCapi;
  conversationId: number;
  /** segundos desde 1970 (GMT) */
  eventTime: number;
  waba: string;
  ctwaClid: string;
  telefone?: string;
  nome?: string;
  valorDoFechamento: number;
}

/** O evento no formato da Conversions API for Business Messaging (ctwa_clid e WABA sem hash; contato com sha256). */
export function montarEvento(e: EntradaDoEvento): Record<string, unknown> {
  const user: Record<string, unknown> = { whatsapp_business_account_id: e.waba, ctwa_clid: e.ctwaClid };
  const fone = soDigitos(e.telefone ?? '');
  // número do Brasil completo (55 + DDD + 8 ou 9 dígitos); outra coisa não vai (hash de lixo só atrapalharia)
  if (/^55\d{10,11}$/.test(fone)) {
    user.ph = [sha256(fone)];
    user.external_id = [sha256(fone)];
    user.country = [sha256('br')];
  }
  const partes = (e.nome ?? '').trim().split(/\s+/).map(parteDoNome).filter(Boolean);
  if (partes.length) user.fn = [sha256(partes[0]!)];
  if (partes.length > 1) user.ln = [sha256(partes[partes.length - 1]!)];
  const evento: Record<string, unknown> = {
    event_name: e.evento,
    event_time: e.eventTime,
    event_id: `chatwoot-${e.conversationId}-${e.evento}`,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: user,
  };
  if (e.evento === 'Purchase') evento.custom_data = { currency: 'BRL', value: e.valorDoFechamento };
  return evento;
}

// ── configuração por unidade ────────────────────────────────────────────────────────────────────────

export interface ConfigDaUnidade {
  token: string | null;
  /** dataset fixo (env); sem ele, descobre pela WABA */
  datasetId: string | null;
  valorDoFechamento: number;
}

/** `doutor-hernia-parauapebas` → `PARAUAPEBAS` (o sufixo das variáveis do n8n). */
export function sufixoDaUnidade(slug: string): string {
  return slug.replace(/^doutor-hernia-/, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function configDaUnidade(slug: string, env: NodeJS.ProcessEnv = process.env): ConfigDaUnidade {
  const s = sufixoDaUnidade(slug);
  const valor = Number(env.CHATWOOT_CAPI_VALOR_FECHAMENTO);
  return {
    token: env[`META_CAPI_TOKEN_${s}`]?.trim() || env[`META_ADS_TOKEN_${s}`]?.trim() || null,
    datasetId: /^\d+$/.test(env[`META_DATASET_ID_${s}`]?.trim() ?? '') ? env[`META_DATASET_ID_${s}`]!.trim() : null,
    valorDoFechamento: Number.isFinite(valor) && valor > 0 ? valor : VALOR_PADRAO_DO_FECHAMENTO,
  };
}

// ── portas (trocáveis no teste) ────────────────────────────────────────────────────────────────────

export interface LinhaCapi {
  conversationId: number;
  regra: string;
  chave: string;
  modo: string;
  texto: string;
  criadoEm: Date;
}

export interface ArmazemCapi {
  /** todas as linhas `capi*` da caixa */
  linhas(caixa: number): Promise<LinhaCapi[]>;
  /** false = já existia */
  registrar(l: LinhaCapi & { caixa: number }): Promise<boolean>;
  desfazer(conversationId: number, regra: string, chave: string): Promise<void>;
  marcar(conversationId: number, regra: string, chave: string, modo: string): Promise<void>;
}

export interface ChatDoCapi {
  /** uma página (25) da listagem da caixa; vazia = acabou */
  pagina(caixa: number, pagina: number): Promise<unknown[]>;
  /** o clique de anúncio da conversa (lê as mensagens até a primeira); null = não veio de anúncio */
  clique(conversationId: number): Promise<CliqueDoAnuncio | null>;
}

/** ok · config (token/permissão: não adianta tentar de novo) · transitorio (Meta fora, limite, rede) · recusou (este evento) · incerto (sem resposta: pode ter ido) */
export type ResultadoDaMeta = { tipo: 'ok' | 'config' | 'transitorio' | 'recusou' | 'incerto'; detalhe?: string };

export interface PortaDaMeta {
  /** dataset da WABA (null = a Meta não tem/ não deixou ver) */
  dataset(waba: string, token: string): Promise<string | null>;
  enviar(datasetId: string, token: string, evento: Record<string, unknown>): Promise<ResultadoDaMeta>;
}

export interface DepsDoCapi {
  armazem: ArmazemCapi;
  chat: ChatDoCapi;
  meta: PortaDaMeta;
  config: (slug: string) => ConfigDaUnidade;
  pausa: (ms: number) => Promise<void>;
}

// ── implementações de verdade ──────────────────────────────────────────────────────────────────────

export function armazemDoBanco(): ArmazemCapi {
  return {
    async linhas(caixa) {
      return prisma.chatwootReguaDisparo.findMany({
        where: { caixa, regra: { startsWith: 'capi' } },
        select: { conversationId: true, regra: true, chave: true, modo: true, texto: true, criadoEm: true },
      });
    },
    async registrar(l) {
      try {
        await prisma.chatwootReguaDisparo.create({ data: l });
        return true;
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') return false;
        throw err;
      }
    },
    async desfazer(conversationId, regra, chave) {
      await prisma.chatwootReguaDisparo.deleteMany({ where: { conversationId, regra, chave } });
    },
    async marcar(conversationId, regra, chave, modo) {
      await prisma.chatwootReguaDisparo.updateMany({ where: { conversationId, regra, chave }, data: { modo } });
    },
  };
}

export function chatDoCapi(ctx: ContextoChatwoot): ChatDoCapi {
  return {
    async pagina(caixa, pagina) {
      const r = (await chamar(ctx, 'GET', 'conversations', {
        query: { inbox_id: String(caixa), status: 'all', assignee_type: 'all', page: String(pagina) },
      })) as { data?: { payload?: unknown[] }; payload?: unknown[] } | null;
      const lista = r?.data?.payload ?? r?.payload ?? [];
      return Array.isArray(lista) ? lista : [];
    },
    async clique(conversationId) {
      const todas: unknown[] = [];
      let antes: number | null = null;
      let chegouAoInicio = false;
      for (let i = 0; i < MAX_PAGINAS_DE_MENSAGENS; i++) {
        const r = (await chamar(ctx, 'GET', `conversations/${conversationId}/messages`, antes ? { query: { before: String(antes) } } : {})) as { payload?: any[] } | null;
        const lista = Array.isArray(r?.payload) ? r.payload : [];
        if (!lista.length) {
          chegouAoInicio = true;
          break;
        }
        todas.push(...lista);
        const menor = Math.min(...lista.map((m) => Number(m?.id) || Infinity));
        if (!Number.isFinite(menor) || (antes !== null && menor >= antes) || lista.length < 20) {
          chegouAoInicio = true;
          break;
        }
        antes = menor;
      }
      const clique = cliqueDasMensagens(todas);
      // não chegou na 1ª mensagem e não achou o clique: o «sem clique» que vai ficar gravado pode estar errado
      if (!clique && !chegouAoInicio) logger.warn({ conversa: conversationId, lidas: todas.length }, `${ID_CAPI}: conversa ${conversationId} tem mais de ${todas.length} mensagens — não achei o clique de anúncio e não cheguei à primeira; fica como «sem clique»`);
      return clique;
    },
  };
}

const GRAPH = () => `${process.env.META_GRAPH_URL || 'https://graph.facebook.com'}/${process.env.META_GRAPH_VERSION || 'v25.0'}`;
/** Códigos de erro da Meta de token/permissão (190 token, 10 e 200–299 permissão, 102 sessão) e de limite/instabilidade (1, 2, 4, 17, 32, 341, 613). */
const CODIGOS_DE_CONFIG = new Set([190, 102, 10, 200, 299, 3]);
const CODIGOS_TRANSITORIOS = new Set([1, 2, 4, 17, 32, 341, 613]);

/** O texto de erro da Meta sem o token (que nunca vai ao log). */
function semToken(texto: string, token: string): string {
  return token ? texto.split(token).join('***') : texto;
}

export function metaDaGraph(fetchFn: typeof fetch = globalThis.fetch): PortaDaMeta {
  /** O dataset de uma WABA não muda: só o que a Meta devolveu de verdade fica guardado. */
  const datasets = new Map<string, string>();
  return {
    async dataset(waba, token) {
      const guardado = datasets.get(waba);
      if (guardado) return guardado;
      const r = await fetchFn(`${GRAPH()}/${waba}/dataset`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      const j = (await r.json().catch(() => null)) as { id?: unknown; data?: Array<{ id?: unknown }>; error?: { message?: string } } | null;
      if (!r.ok) throw new Error(`Meta ${r.status} ao ler o dataset da WABA ${waba}: ${semToken(String(j?.error?.message ?? '').slice(0, 200), token)}`);
      const id = j?.data?.[0]?.id ?? j?.id;
      if (typeof id !== 'string' && typeof id !== 'number') return null;
      datasets.set(waba, String(id));
      return String(id);
    },
    async enviar(datasetId, token, evento) {
      let r: Response;
      try {
        r = await fetchFn(`${GRAPH()}/${datasetId}/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [evento] }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        const nome = (err as { name?: string })?.name;
        // tempo esgotado: a Meta pode ter recebido. Erro de conexão: não chegou lá.
        if (nome === 'TimeoutError' || nome === 'AbortError') return { tipo: 'incerto', detalhe: 'tempo esgotado sem resposta' };
        return { tipo: 'transitorio', detalhe: semToken(String(err).slice(0, 200), token) };
      }
      const j = (await r.json().catch(() => null)) as { events_received?: number; error?: { code?: number; message?: string } } | null;
      if (r.ok && j?.events_received === 1) return { tipo: 'ok' };
      const codigo = Number(j?.error?.code);
      const detalhe = semToken(`HTTP ${r.status} · ${String(j?.error?.message ?? JSON.stringify(j) ?? '').slice(0, 250)}`, token);
      if (r.status === 401 || r.status === 403 || CODIGOS_DE_CONFIG.has(codigo) || (codigo >= 200 && codigo <= 299)) return { tipo: 'config', detalhe };
      if (r.status >= 500 || r.status === 429 || CODIGOS_TRANSITORIOS.has(codigo)) return { tipo: 'transitorio', detalhe };
      // 200 sem events_received = a Meta não confirmou: não dá para saber
      if (r.ok) return { tipo: 'incerto', detalhe };
      return { tipo: 'recusou', detalhe };
    },
  };
}

// ── o ciclo ────────────────────────────────────────────────────────────────────────────────────────

export interface ResumoDoCapi {
  conversas: number;
  /** eventos que o seco registrou como «enviaria» */
  seco: number;
  enviados: number;
  /** viraram «sem clique de anúncio» (lead orgânico) */
  semClique: number;
  expirados: number;
  falhas: number;
  desistiu: number;
  incertos: number;
  /** o ciclo parou no meio (configuração ou Meta fora do ar) */
  interrompido: string | null;
  primeiraVez: boolean;
}

const avisados = new Set<string>();
/** Um aviso por motivo até o motivo sumir (limparAviso): sem token não enche o log a cada 10 min. */
function avisarUmaVez(chave: string, dados: Record<string, unknown>, msg: string): void {
  if (avisados.has(chave)) return;
  avisados.add(chave);
  logger.warn(dados, msg);
}
const limparAviso = (chave: string) => avisados.delete(chave);
export function _limparAvisosParaTeste(): void {
  avisados.clear();
}

const REGRA_PARTIDA = 'capi-partida';
/** A UNIQUE da tabela não tem a caixa: a linha de partida de cada caixa mora num «conversationId» próprio (negativo, nunca colide com conversa). */
const idDaPartida = (caixa: number) => -caixa;
const REGRA_CLIQUE = 'capi-clique';
const chaveDe = (regra: string, chave: string) => `${regra}|${chave}`;

/** O clique guardado na linha `capi-clique`; texto vazio ou estragado = sem clique (nunca derruba o ciclo). */
function cliqueGuardado(texto: string): CliqueDoAnuncio | null {
  if (!texto) return null;
  try {
    const j = JSON.parse(texto) as Partial<CliqueDoAnuncio> | null;
    return typeof j?.ctwaClid === 'string' && j.ctwaClid ? { ctwaClid: j.ctwaClid, anuncio: typeof j.anuncio === 'string' ? j.anuncio : null } : null;
  } catch {
    return null;
  }
}

async function lerConversas(chat: ChatDoCapi, caixa: number): Promise<ConversaRegua[]> {
  const vistas = new Set<number>();
  const conversas: ConversaRegua[] = [];
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const pagina = await chat.pagina(caixa, p);
    if (pagina.length === 0) break;
    for (const raw of pagina) {
      const c = conversaDoChatwoot(raw);
      if (!c || vistas.has(c.id)) continue;
      vistas.add(c.id);
      conversas.push(c);
    }
  }
  return conversas;
}

/**
 * Um ciclo de uma caixa. `modo` nunca é «desligado». Falha ao LISTAR as conversas aborta o ciclo sem gravar nada.
 * Falha numa conversa só conta em `falhas` e segue.
 */
export async function cicloDoCapi(deps: DepsDoCapi, caixa: number, slug: string, waba: string, modo: 'seco' | 'ligado', agora: Date): Promise<ResumoDoCapi> {
  const { armazem } = deps;
  const conversas = await lerConversas(deps.chat, caixa);
  const linhas = await armazem.linhas(caixa);
  const porConversa = new Map<number, Map<string, LinhaCapi>>();
  for (const l of linhas) {
    const m = porConversa.get(l.conversationId) ?? new Map<string, LinhaCapi>();
    m.set(chaveDe(l.regra, l.chave), l);
    porConversa.set(l.conversationId, m);
  }
  const primeiraVez = !porConversa.get(idDaPartida(caixa))?.has(chaveDe(REGRA_PARTIDA, 'v1'));
  const resumo: ResumoDoCapi = { conversas: conversas.length, seco: 0, enviados: 0, semClique: 0, expirados: 0, falhas: 0, desistiu: 0, incertos: 0, interrompido: null, primeiraVez };

  const cfg = deps.config(slug);
  const avisoToken = `${slug}|sem-token`;
  let datasetId = cfg.datasetId;
  let buscas = 0;
  let envios = 0;
  /** configuração faltando ou Meta fora do ar: não manda mais neste ciclo, mas segue anotando as entradas (o horário do evento é o da 1ª vez que vimos) */
  let parado: string | null = null;

  const gravar = (conversationId: number, regra: string, chave: string, modoDaLinha: string, texto = '') =>
    armazem.registrar({ caixa, conversationId, regra, chave, modo: modoDaLinha, texto, criadoEm: agora });

  for (const c of conversas) {
    const eventos = eventosAlcancados(c.attrs);
    if (!eventos.length) continue;
    const minhas = porConversa.get(c.id) ?? new Map<string, LinhaCapi>();
    porConversa.set(c.id, minhas);
    try {
      let clique: CliqueDoAnuncio | null | undefined; // undefined = ainda não lido neste ciclo
      for (const evento of eventos) {
        if (minhas.has(chaveDe(`capi:${evento}`, 'v1'))) continue; // já resolvido (enviado, sem clique, expirado…)

        // 1) a ENTRADA: a 1ª vez que o worker viu a conversa neste estado
        let visto = minhas.get(chaveDe(`capi-visto:${evento}`, 'v1'));
        if (!visto) {
          const linha: LinhaCapi = { conversationId: c.id, regra: `capi-visto:${evento}`, chave: 'v1', modo: primeiraVez ? 'inicial' : 'novo', texto: '', criadoEm: agora };
          if (!(await armazem.registrar({ caixa, ...linha }))) continue; // outra cópia do servidor acabou de ver
          minhas.set(chaveDe(linha.regra, linha.chave), linha);
          visto = linha;
        }
        if (visto.modo === 'inicial') continue; // já era assim antes de o worker passar a olhar

        // 2) o clique de anúncio (lido uma vez por conversa e guardado)
        if (clique === undefined) {
          const guardado = minhas.get(chaveDe(REGRA_CLIQUE, 'v1'));
          if (guardado) {
            clique = cliqueGuardado(guardado.texto);
          } else {
            if (buscas >= MAX_BUSCAS_DE_CLIQUE_POR_CICLO) break; // o resto fica para o próximo ciclo
            buscas++;
            clique = await deps.chat.clique(c.id);
            const texto = clique ? JSON.stringify(clique) : '';
            if (await gravar(c.id, REGRA_CLIQUE, 'v1', clique ? 'com-clique' : 'sem-clique', texto)) minhas.set(chaveDe(REGRA_CLIQUE, 'v1'), { conversationId: c.id, regra: REGRA_CLIQUE, chave: 'v1', modo: '', texto, criadoEm: agora });
            await deps.pausa(PAUSA_ENTRE_CHAMADAS_MS);
          }
        }
        if (!clique?.ctwaClid) {
          if (await gravar(c.id, `capi:${evento}`, 'v1', 'sem-clique')) resumo.semClique++;
          continue;
        }

        // 3) seco: só registra e loga
        if (modo === 'seco') {
          if (minhas.has(chaveDe(`capi-seco:${evento}`, 'v1'))) continue;
          if (!(await gravar(c.id, `capi-seco:${evento}`, 'v1', 'seco', JSON.stringify({ anuncio: clique.anuncio })))) continue;
          resumo.seco++;
          logger.info({ slug, caixa, conversa: c.id, evento, anuncio: clique.anuncio }, `${ID_CAPI}: [SECO] enviaria evento ${evento} (${SIGNIFICADO_DO_EVENTO[evento]}) para a conversa ${c.id} (anúncio ${clique.anuncio ?? 'sem id'})`);
          continue;
        }

        // 4) ligado
        if (agora.getTime() - visto.criadoEm.getTime() > JANELA_DA_META_MS) {
          if (await gravar(c.id, `capi:${evento}`, 'v1', 'expirou')) resumo.expirados++;
          logger.warn({ slug, caixa, conversa: c.id, evento }, `${ID_CAPI}: evento ${evento} da conversa ${c.id} tem mais de 7 dias — a Meta não aceita, não mando`);
          continue;
        }
        if (parado) continue;
        if (!cfg.token) {
          avisarUmaVez(avisoToken, { slug, caixa }, `${ID_CAPI}: ligado, mas sem token da Meta (META_ADS_TOKEN_${sufixoDaUnidade(slug)}) — não mando nada`);
          parado = resumo.interrompido = 'sem token';
          continue;
        }
        limparAviso(avisoToken);
        if (!datasetId) {
          try {
            datasetId = await deps.meta.dataset(waba, cfg.token);
          } catch (err) {
            avisarUmaVez(`${slug}|dataset`, { slug, caixa, err: String(err) }, `${ID_CAPI}: não consegui o dataset da WABA ${waba} — não mando nada (tento no próximo ciclo)`);
            parado = resumo.interrompido = 'sem dataset';
            continue;
          }
          if (!datasetId) {
            avisarUmaVez(`${slug}|dataset`, { slug, caixa }, `${ID_CAPI}: a WABA ${waba} não tem dataset (crie com POST /{WABA}/dataset ou ponha META_DATASET_ID_${sufixoDaUnidade(slug)}) — não mando nada`);
            parado = resumo.interrompido = 'sem dataset';
            continue;
          }
          limparAviso(`${slug}|dataset`);
        }
        if (envios >= MAX_ENVIOS_POR_CICLO) {
          parado = resumo.interrompido = 'teto de envios do ciclo';
          continue;
        }
        // a linha ANTES de chamar a Meta: é ela que impede repetir
        const corpo = montarEvento({
          evento,
          conversationId: c.id,
          eventTime: Math.floor(visto.criadoEm.getTime() / 1000),
          waba,
          ctwaClid: clique.ctwaClid,
          telefone: c.telefone,
          nome: c.nome,
          valorDoFechamento: cfg.valorDoFechamento,
        });
        if (!(await gravar(c.id, `capi:${evento}`, 'v1', 'enviado', JSON.stringify({ event_id: corpo.event_id, anuncio: clique.anuncio })))) continue;
        envios++;
        const r = await deps.meta.enviar(datasetId, cfg.token, corpo);
        await deps.pausa(PAUSA_ENTRE_CHAMADAS_MS);
        if (r.tipo === 'ok') {
          limparAviso(`${slug}|config`);
          limparAviso(`${slug}|transitorio`);
          resumo.enviados++;
          logger.info({ slug, caixa, conversa: c.id, evento, anuncio: clique.anuncio }, `${ID_CAPI}: evento ${evento} enviado à Meta (conversa ${c.id}, anúncio ${clique.anuncio ?? 'sem id'})`);
          continue;
        }
        if (r.tipo === 'incerto') {
          await armazem.marcar(c.id, `capi:${evento}`, 'v1', 'incerto');
          resumo.incertos++;
          logger.error({ slug, caixa, conversa: c.id, evento, detalhe: r.detalhe }, `${ID_CAPI}: sem confirmação da Meta para ${evento} da conversa ${c.id} — NÃO repito (pode ter ido); conferir no Gerenciador de Eventos`);
          continue;
        }
        // a Meta não ficou com o evento: desfaz a trava para tentar de novo
        await armazem.desfazer(c.id, `capi:${evento}`, 'v1');
        if (r.tipo === 'config' || r.tipo === 'transitorio') {
          avisarUmaVez(`${slug}|${r.tipo}`, { slug, caixa, conversa: c.id, evento, tipo: r.tipo, detalhe: r.detalhe }, `${ID_CAPI}: ${r.tipo === 'config' ? 'a Meta recusou o token/permissão' : 'a Meta não está respondendo direito'} — paro o ciclo desta unidade e tento no próximo (este aviso não se repete até a Meta voltar a aceitar)`);
          resumo.falhas++;
          parado = resumo.interrompido = r.tipo;
          continue;
        }
        resumo.falhas++;
        const tentativas = [...minhas.keys()].filter((k) => k.startsWith(`capi-falha:${evento}|`)).length + 1;
        if (tentativas >= MAX_TENTATIVAS) {
          if (await gravar(c.id, `capi:${evento}`, 'v1', 'desistiu')) resumo.desistiu++;
          logger.error({ slug, caixa, conversa: c.id, evento, detalhe: r.detalhe }, `${ID_CAPI}: a Meta recusou ${evento} da conversa ${c.id} ${tentativas} vezes — desisto desse evento`);
        } else {
          await gravar(c.id, `capi-falha:${evento}`, String(tentativas), 'falhou', r.detalhe ?? '');
          minhas.set(chaveDe(`capi-falha:${evento}`, String(tentativas)), { conversationId: c.id, regra: `capi-falha:${evento}`, chave: String(tentativas), modo: 'falhou', texto: '', criadoEm: agora });
          logger.warn({ slug, caixa, conversa: c.id, evento, tentativa: tentativas, detalhe: r.detalhe }, `${ID_CAPI}: a Meta recusou ${evento} da conversa ${c.id} (tentativa ${tentativas}) — tento no próximo ciclo`);
        }
      }
    } catch (err) {
      resumo.falhas++;
      logger.warn({ err: String(err), slug, caixa, conversa: c.id }, `${ID_CAPI}: falhou numa conversa — sigo com as outras`);
    }
  }
  // a partida só vale se a 1ª varredura anotou TODAS as conversas: senão a que faltou seria vista como «nova» no ciclo seguinte
  if (primeiraVez && resumo.falhas === 0) {
    await armazem.registrar({ caixa, conversationId: idDaPartida(caixa), regra: REGRA_PARTIDA, chave: 'v1', modo, texto: '', criadoEm: agora });
  }
  logger.info({ slug, caixa, modo, ...resumo }, `${ID_CAPI}: ciclo`);
  return resumo;
}

// ── liga/desliga ───────────────────────────────────────────────────────────────────────────────────

export const estadoDoCapi = (slug: string): Estado => estadoDaAutomacao(slug, ID_CAPI, process.env.CHATWOOT_CAPI_SLUGS);

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;
/** uma só porta da Meta para o worker todo (guarda o dataset entre ciclos) */
let metaDoWorker: PortaDaMeta | null = null;

async function varrer(ctx: ContextoChatwoot): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const deps: DepsDoCapi = {
      armazem: armazemDoBanco(),
      chat: chatDoCapi(ctx),
      meta: (metaDoWorker ??= metaDaGraph()),
      config: (slug) => configDaUnidade(slug),
      pausa: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    for (const [caixaTxt, { slug, waba }] of Object.entries(CAIXAS_CAPI)) {
      const modo = estadoDoCapi(slug);
      if (modo === 'desligado') continue;
      try {
        await cicloDoCapi(deps, Number(caixaTxt), slug, waba, modo, new Date());
      } catch (err) {
        logger.warn({ err: String(err), slug }, `${ID_CAPI}: ciclo falhou — tento no próximo`);
      }
    }
  } finally {
    rodando = false;
  }
}

export function startChatwootCapiWorker(): void {
  if (timer) return;
  const conta = contaChatwootDoAmbiente();
  if (!conta) {
    logger.info(`${ID_CAPI}: sem CHATWOOT_API_TOKEN/CHATWOOT_CONTA_ID — worker não sobe`);
    return;
  }
  const ctx = criarContextoChatwoot(conta);
  primeira = setTimeout(() => void varrer(ctx), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(ctx), SWEEP_MS);
  logger.info(`${ID_CAPI}: worker iniciado`);
}

export function stopChatwootCapiWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
