/**
 * Origem e campanha no CONTATO do Chatwoot (`chatwoot-origem`; João, 13–14/11/2026: "eles vão preencher o campo automaticamente?
 * faça você mesmo") — o mesmo que o rastreio do Kommo faz no cartão. Refeito sobre o `kapso-referral` (o Chatwoot perde o código
 * do anúncio no caminho do Kapso; o servidor busca no Kapso).
 *
 * Quando uma mensagem de paciente comprovadamente veio de anúncio «Clique para o WhatsApp» (referral achado no Kapso):
 *   Origem = «Meta Ads» (opção da lista do Chatwoot) + Campanha e Conjunto de anúncios com os NOMES lidos na Meta pelo id do anúncio.
 * Regras (achados do sênior na 1ª versão, #324):
 *  - NUNCA marca «Orgânico» por dedução (sem referral não dá para saber: anúncio em Status não manda, Kapso pode falhar);
 *  - RELÊ o contato logo antes de gravar e só preenche campo VAZIO (o que a menina pôs à mão fica; duas mensagens seguidas não brigam);
 *  - origem manual diferente de «Meta Ads» → não mexe em campanha;
 *  - erro da Meta aparece no log (status/código, nunca o token).
 * SÓ NO PAPEL: não grava; loga «[SECO] preencheria…». Estado por unidade na tela de automações (CHATWOOT_ORIGEM_SLUGS).
 */
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { sufixoDaUnidade } from './chatwoot-gestor.js';
import type { ReferralDoKapso } from './kapso-referral.js';

export const ID_ORIGEM = 'chatwoot-origem';
export const ORIGEM_ANUNCIO = 'Meta Ads';
const GRAPH = `${process.env.META_GRAPH_URL || 'https://graph.facebook.com'}/${process.env.META_GRAPH_VERSION || 'v23.0'}`;

export interface NomesDoAnuncio {
  campanha: string | null;
  conjunto: string | null;
}
type Atual = { origem?: unknown; campanha_nome?: unknown; conjunto?: unknown };
const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** O que gravar no contato (só campos vazios), ou null. Função pura. */
export function decidirOrigem(atual: Atual, nomes: NomesDoAnuncio | null): Record<string, string> | null {
  const grava: Record<string, string> = {};
  const origem = txt(atual.origem);
  if (!origem) grava.origem = ORIGEM_ANUNCIO;
  if ((origem || ORIGEM_ANUNCIO) === ORIGEM_ANUNCIO) {
    if (!txt(atual.campanha_nome) && nomes?.campanha) grava.campanha_nome = nomes.campanha.slice(0, 200);
    if (!txt(atual.conjunto) && nomes?.conjunto) grava.conjunto = nomes.conjunto.slice(0, 200);
  }
  return Object.keys(grava).length ? grava : null;
}

type Buscar = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
const cache = new Map<string, { ate: number; v: NomesDoAnuncio | null }>();
export function limparCacheDaOrigem(): void {
  cache.clear();
}

/** Nomes da campanha e do conjunto do anúncio (token só no cabeçalho; erro da Meta vai para o log). null = não deu. */
export async function nomesDoAnuncio(anuncio: string, token: string, buscar: Buscar = fetch as unknown as Buscar, agora: () => number = Date.now): Promise<NomesDoAnuncio | null> {
  const hit = cache.get(anuncio);
  if (hit && hit.ate > agora()) return hit.v;
  let v: NomesDoAnuncio | null = null;
  try {
    const r = await buscar(`${GRAPH}/${encodeURIComponent(anuncio)}?fields=campaign%7Bname%7D,adset%7Bname%7D`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => null)) as { campaign?: { name?: unknown }; adset?: { name?: unknown }; error?: { code?: unknown } } | null;
    if (r.ok && j) v = { campanha: txt(j.campaign?.name) || null, conjunto: txt(j.adset?.name) || null };
    else logger.warn({ anuncio, status: r.status, codigo: j?.error?.code }, `${ID_ORIGEM}: a Meta recusou a leitura do anúncio`);
  } catch (err) {
    logger.warn({ anuncio, err: String(err).replace(token, '***') }, `${ID_ORIGEM}: não consegui ler o anúncio na Meta`);
  }
  cache.set(anuncio, { ate: agora() + (v ? 6 * 3_600_000 : 10 * 60_000), v });
  if (cache.size > 500) cache.clear();
  return v;
}

/** O token de anúncios da unidade (o mesmo do Marketing): META_ADS_TOKEN_<UNIDADE> ou units.meta_access_token. */
async function tokenDeAnuncios(slug: string): Promise<string | null> {
  const env = (process.env[`META_ADS_TOKEN_${sufixoDaUnidade(slug)}`] ?? '').trim();
  if (env) return env;
  const u = await prisma.unit.findUnique({ where: { slug }, select: { metaAccessToken: true } }).catch(() => null);
  return u?.metaAccessToken?.trim() || null;
}

export interface PortasDaOrigem {
  estado(slug: string): Estado;
  /** os campos do contato AGORA (relidos antes de gravar) */
  contato(contato: number): Promise<Atual>;
  nomes(slug: string, anuncio: string): Promise<NomesDoAnuncio | null>;
  gravar(contato: number, campos: Record<string, string>): Promise<void>;
}

export function portasDaOrigem(ctx: ContextoChatwoot): PortasDaOrigem {
  return {
    estado: (slug) => estadoDaAutomacao(slug, ID_ORIGEM, process.env.CHATWOOT_ORIGEM_SLUGS),
    async contato(contato) {
      const r = (await chamar(ctx, 'GET', `contacts/${contato}`)) as { payload?: { custom_attributes?: Atual }; custom_attributes?: Atual } | null;
      return r?.payload?.custom_attributes ?? r?.custom_attributes ?? {};
    },
    async nomes(slug, anuncio) {
      const token = await tokenDeAnuncios(slug);
      return token ? nomesDoAnuncio(anuncio, token) : null;
    },
    async gravar(contato, campos) {
      // o Chatwoot MESCLA custom_attributes no PUT do contato (contacts_controller#contact_custom_attributes)
      await chamar(ctx, 'PUT', `contacts/${contato}`, { corpo: { custom_attributes: campos } });
    },
  };
}

export const ETIQUETA_ANUNCIO = 'anuncio';

/**
 * Etiqueta «anuncio» na CONVERSA que comprovadamente veio de anúncio (João, 14/11/2026: "onde vejo essas conversas que veio de
 * anúncio?"). É informação, não ação: vale mesmo com `chatwoot-origem` desligada ou no papel. ACRESCENTA (relê as etiquetas e
 * manda a lista inteira; nunca tira as outras). Publicação impulsionada que não é anúncio (tipo «post») não ganha.
 * CHATWOOT_ETIQUETA_ANUNCIO=0 desliga. Não lança.
 */
export async function etiquetarAnuncio(
  conversa: number,
  ref: ReferralDoKapso,
  adicionar: (conversa: number, etiquetas: string[]) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.CHATWOOT_ETIQUETA_ANUNCIO === '0' || ref.tipo !== 'ad') return false;
  try {
    await adicionar(conversa, [ETIQUETA_ANUNCIO]);
    return true;
  } catch (err) {
    logger.warn({ conversa, err: String(err) }, `${ID_ORIGEM}: não consegui pôr a etiqueta ${ETIQUETA_ANUNCIO}`);
    return false;
  }
}

/** Roda quando o servidor achou o referral de anúncio de uma mensagem. Não lança. */
export async function preencherOrigem(
  e: { slug: string; contato: number; conversa: number; ref: ReferralDoKapso },
  p: PortasDaOrigem,
): Promise<'desligado' | 'nada' | 'seco' | 'gravado'> {
  try {
    const modo = p.estado(e.slug);
    if (modo === 'desligado') return 'desligado';
    if (e.ref.tipo !== 'ad') return 'nada'; // publicação (não anúncio): não chuta origem
    const antes = await p.contato(e.contato);
    const precisaNome = !!e.ref.anuncio && (!txt(antes.campanha_nome) || !txt(antes.conjunto)) && (txt(antes.origem) || ORIGEM_ANUNCIO) === ORIGEM_ANUNCIO;
    const nomes = precisaNome ? await p.nomes(e.slug, e.ref.anuncio!).catch(() => null) : null;
    // relê na hora de gravar: outra mensagem (ou a menina) pode ter preenchido enquanto a Meta respondia
    const agora = precisaNome ? await p.contato(e.contato) : antes;
    const grava = decidirOrigem(agora, nomes);
    if (!grava) return 'nada';
    if (modo === 'seco') {
      logger.info({ slug: e.slug, conversa: e.conversa, contato: e.contato, grava }, `${ID_ORIGEM}: [SECO] preencheria no contato ${e.contato}: ${JSON.stringify(grava)}`);
      return 'seco';
    }
    await p.gravar(e.contato, grava);
    logger.info({ slug: e.slug, conversa: e.conversa, contato: e.contato, grava }, `${ID_ORIGEM}: preenchido no contato ${e.contato}`);
    return 'gravado';
  } catch (err) {
    logger.warn({ slug: e.slug, contato: e.contato, err: String(err) }, `${ID_ORIGEM}: falhou`);
    return 'nada';
  }
}
