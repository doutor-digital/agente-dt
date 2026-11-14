/**
 * Origem e campanha no CONTATO do Chatwoot (`chatwoot-origem`, pedido do João, 13/11/2026: "eles vão preencher o campo
 * automaticamente? faça você mesmo") — o mesmo que o rastreio do Kommo faz no cartão.
 *
 * Quando chega mensagem de paciente numa caixa de unidade:
 *  - a mensagem traz o anúncio «Clique para o WhatsApp» (`content_attributes.referral`, que o Chatwoot guarda inteiro) →
 *    Origem = «Meta Ads», e Campanha / Conjunto de anúncios com os NOMES lidos na Meta pelo id do anúncio
 *    (`GET /{anúncio}?fields=campaign{name},adset{name}`, token de anúncios da unidade, cache de 6 h);
 *  - não traz e é o COMEÇO de uma conversa nova (criada há menos de 10 min) → Origem = «Orgânico».
 * NUNCA sobrescreve: só grava campo que está vazio no contato (o que a menina preencheu à mão fica). Não escreve na conversa nem
 * manda nada ao paciente. Sem token de anúncios, ou a Meta não responde: grava só a Origem (a campanha fica para quem preencher).
 *
 * SÓ NO PAPEL: não grava; loga «[SECO] preencheria no contato N: …». Estado por unidade na tela de automações
 * (CHATWOOT_ORIGEM_SLUGS no ambiente).
 */
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { sufixoDaUnidade } from './chatwoot-gestor.js';

export const ID_ORIGEM = 'chatwoot-origem';
/** as opções da lista «Origem» do contato no Chatwoot (atributo `origem`, tipo lista) */
export const ORIGEM_ANUNCIO = 'Meta Ads';
export const ORIGEM_ORGANICO = 'Orgânico';
/** conversa «nova» = criada até 10 min antes da mensagem */
const CONVERSA_NOVA_MS = 10 * 60_000;
const GRAPH = `${process.env.META_GRAPH_URL || 'https://graph.facebook.com'}/${process.env.META_GRAPH_VERSION || 'v23.0'}`;

export interface EventoDeOrigem {
  conversa: number;
  slug: string;
  contato: number;
  /** o que o contato já tem (só os 3 campos que o robô cuida) */
  atual: { origem: string; campanha_nome: string; conjunto: string };
  /** id do anúncio quando a mensagem veio de anúncio; '' quando veio de publicação (sem id de anúncio) */
  anuncio: string | null;
  /** a conversa foi criada há pouco (é o começo dela) */
  conversaNova: boolean;
}

const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Corpo do webhook do Chatwoot → mensagem de paciente numa caixa de unidade, com o que o robô precisa; ou null. */
export function eventoDeOrigem(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): EventoDeOrigem | null {
  if (corpo?.event !== 'message_created') return null;
  const tipo = corpo?.message_type;
  if (!(tipo === 'incoming' || tipo === 0) || corpo?.private === true) return null;
  const conversa = Number(corpo?.conversation?.id);
  const slug = caixas[Number(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id)];
  const contato = Number(corpo?.sender?.id);
  if (!Number.isInteger(conversa) || conversa <= 0 || !slug || !Number.isInteger(contato) || contato <= 0) return null;
  // grupo de WhatsApp e o bot do Evolution não são paciente
  if (/@g\.us$/i.test(txt(corpo?.sender?.identifier)) || txt(corpo?.sender?.phone_number) === '+123456') return null;
  const ca = corpo?.sender?.custom_attributes ?? {};
  const ref = corpo?.content_attributes?.referral;
  const temRef = !!ref && typeof ref === 'object' && Object.keys(ref).length > 0;
  const anuncio = temRef ? (txt(ref.source_type).toLowerCase() === 'ad' && /^\d{5,25}$/.test(txt(ref.source_id)) ? txt(ref.source_id) : '') : null;
  const criada = Number(corpo?.conversation?.created_at) * 1000;
  const msg = Date.parse(String(corpo?.created_at ?? '')) || Date.now();
  return {
    conversa,
    slug,
    contato,
    atual: { origem: txt(ca.origem), campanha_nome: txt(ca.campanha_nome), conjunto: txt(ca.conjunto) },
    anuncio,
    conversaNova: Number.isFinite(criada) && criada > 0 && msg - criada <= CONVERSA_NOVA_MS,
  };
}

export interface NomesDoAnuncio {
  campanha: string | null;
  conjunto: string | null;
}

/** O que gravar no contato (só campos vazios), ou null = nada a fazer. Função pura. */
export function decidirOrigem(e: EventoDeOrigem, nomes: NomesDoAnuncio | null): Record<string, string> | null {
  const grava: Record<string, string> = {};
  if (e.anuncio !== null) {
    if (!e.atual.origem) grava.origem = ORIGEM_ANUNCIO;
    // a campanha só entra se a Origem do contato é (ou vai ser) anúncio: não mistura com uma origem posta à mão
    if ((e.atual.origem || ORIGEM_ANUNCIO) === ORIGEM_ANUNCIO) {
      if (!e.atual.campanha_nome && nomes?.campanha) grava.campanha_nome = nomes.campanha.slice(0, 200);
      if (!e.atual.conjunto && nomes?.conjunto) grava.conjunto = nomes.conjunto.slice(0, 200);
    }
  } else if (e.conversaNova && !e.atual.origem) {
    grava.origem = ORIGEM_ORGANICO;
  }
  return Object.keys(grava).length ? grava : null;
}

type Buscar = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
const cache = new Map<string, { ate: number; v: NomesDoAnuncio | null }>();
export function limparCacheDaOrigem(): void {
  cache.clear();
}

/** Nomes da campanha e do conjunto do anúncio (token só no cabeçalho). null = não deu para ler (não trava a Origem). */
export async function nomesDoAnuncio(anuncio: string, token: string, buscar: Buscar = fetch as unknown as Buscar, agora: () => number = Date.now): Promise<NomesDoAnuncio | null> {
  const hit = cache.get(anuncio);
  if (hit && hit.ate > agora()) return hit.v;
  let v: NomesDoAnuncio | null = null;
  try {
    const r = await buscar(`${GRAPH}/${anuncio}?fields=campaign%7Bname%7D,adset%7Bname%7D`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => null)) as { campaign?: { name?: unknown }; adset?: { name?: unknown } } | null;
    if (r.ok && j) v = { campanha: txt(j.campaign?.name) || null, conjunto: txt(j.adset?.name) || null };
  } catch (err) {
    logger.warn({ anuncio, err: String(err).replace(token, '***') }, `${ID_ORIGEM}: não consegui ler o anúncio na Meta`);
  }
  // falha fica 10 min no cache (não martela a Meta); acerto, 6 h
  cache.set(anuncio, { ate: agora() + (v ? 6 * 3_600_000 : 10 * 60_000), v });
  if (cache.size > 500) cache.clear();
  return v;
}

/** O token de anúncios da unidade: o mesmo do Marketing (`META_ADS_TOKEN_<UNIDADE>` ou units.meta_access_token). */
async function tokenDeAnuncios(slug: string): Promise<string | null> {
  const env = (process.env[`META_ADS_TOKEN_${sufixoDaUnidade(slug)}`] ?? '').trim();
  if (env) return env;
  const u = await prisma.unit.findUnique({ where: { slug }, select: { metaAccessToken: true } }).catch(() => null);
  return u?.metaAccessToken?.trim() || null;
}

export interface PortasDaOrigem {
  estado(slug: string): Estado;
  nomes(slug: string, anuncio: string): Promise<NomesDoAnuncio | null>;
  gravar(contato: number, campos: Record<string, string>): Promise<void>;
}

export function portasDaOrigem(ctx: ContextoChatwoot): PortasDaOrigem {
  return {
    estado: (slug) => estadoDaAutomacao(slug, ID_ORIGEM, process.env.CHATWOOT_ORIGEM_SLUGS),
    async nomes(slug, anuncio) {
      const token = await tokenDeAnuncios(slug);
      return token ? nomesDoAnuncio(anuncio, token) : null;
    },
    async gravar(contato, campos) {
      // o Chatwoot MESCLA custom_attributes no PUT do contato (contacts_controller#contact_custom_attributes): os outros ficam
      await chamar(ctx, 'PUT', `contacts/${contato}`, { corpo: { custom_attributes: campos } });
    },
  };
}

/** Roda para uma mensagem de paciente. Não lança. */
export async function aplicarOrigem(e: EventoDeOrigem, p: PortasDaOrigem): Promise<'desligado' | 'nada' | 'seco' | 'gravado'> {
  const modo = p.estado(e.slug);
  if (modo === 'desligado') return 'desligado';
  // só busca o nome na Meta se vai precisar dele
  const precisaNome = !!e.anuncio && (!e.atual.campanha_nome || !e.atual.conjunto) && (e.atual.origem || ORIGEM_ANUNCIO) === ORIGEM_ANUNCIO;
  const nomes = precisaNome ? await p.nomes(e.slug, e.anuncio!).catch(() => null) : null;
  const grava = decidirOrigem(e, nomes);
  if (!grava) return 'nada';
  if (modo === 'seco') {
    logger.info({ slug: e.slug, conversa: e.conversa, contato: e.contato, grava }, `${ID_ORIGEM}: [SECO] preencheria no contato ${e.contato}: ${JSON.stringify(grava)}`);
    return 'seco';
  }
  try {
    await p.gravar(e.contato, grava);
    logger.info({ slug: e.slug, conversa: e.conversa, contato: e.contato, grava }, `${ID_ORIGEM}: preenchido no contato ${e.contato}`);
    return 'gravado';
  } catch (err) {
    logger.warn({ slug: e.slug, contato: e.contato, err: String(err) }, `${ID_ORIGEM}: não consegui gravar no contato`);
    return 'nada';
  }
}
