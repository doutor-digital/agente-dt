/**
 * O código do anúncio que o Chatwoot PERDE (medido 14/11/2026): o Kapso recebe o `referral` do «Clique para o WhatsApp»
 * (com o `ctwa_clid` que a Meta exige nas conversões), mas a mensagem chega ao Chatwoot sem ele — 0 mensagens com referral no
 * banco do Chatwoot, contra 16 conversas da caixa oficial com referral na API do Kapso.
 *
 * Conserto: a cada mensagem de PACIENTE que chega na caixa de WhatsApp oficial (CAIXAS_CLOUD) sem referral, pergunta ao Kapso
 * pela própria mensagem (`GET /meta/whatsapp/<versão>/<número>/messages/<wamid>` — o filtro por telefone do Kapso é ignorado) e,
 * se veio de anúncio, guarda numa linha `kapso-referral` de `chatwoot_regua_disparo` (UNIQUE conversa+regra+wamid: não duplica).
 * O rastreio de conversões (chatwoot-capi) e o Marketing usam essa linha quando o Chatwoot não tem o referral.
 * Chave do Kapso: KAPSO_API_KEY no ambiente do agente; o número: KAPSO_PHONE_NUMBER_IDS (padrão Parauapebas).
 */
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { CAIXAS_CLOUD } from './chatwoot-regua.js';
import { configDaUnidade, numerosDoKapsoConfigurados, numerosForaDaLista, unidadeDaCaixa } from './chatwoot-unidades.js';

export const REGRA_KAPSO_REFERRAL = 'kapso-referral';
const KAPSO = 'https://api.kapso.ai/meta/whatsapp/v24.0';

export interface ReferralDoKapso {
  /** id do anúncio (`source_id` quando `source_type` = ad) */
  anuncio: string | null;
  ctwaClid: string | null;
  tipo: string | null;
  titulo: string | null;
  url: string | null;
  /** quando a mensagem chegou (ms) */
  quando: number;
  /** o texto do anúncio (`body`), para a nota «Veio do anúncio» (chatwoot-anuncio.ts) */
  corpo?: string | null;
  /** imagem do anúncio (`image_url`; vídeo: `thumbnail_url`) — link da Meta que EXPIRA em dias: baixar na hora */
  midia?: string | null;
  /** `media_type` (image | video) */
  tipoMidia?: string | null;
  /** anúncio em vídeo: o link do vídeo no Facebook (`video_url`) */
  video?: string | null;
}

const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
const longo = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

const avisadosForaDaLista = new Set<string>();
export function numerosDoKapso(env: NodeJS.ProcessEnv = process.env): string[] {
  const l = String(env.KAPSO_PHONE_NUMBER_IDS ?? '').split(/[\s,]+/).filter((x) => /^\d{5,25}$/.test(x));
  // a variável de ambiente, SE existir, manda (como sempre); sem ela valem os números das unidades configuradas (Parauapebas é a semente,
  // que era o padrão). Atenção ao ligar unidade nova: com KAPSO_PHONE_NUMBER_IDS definida, o número dela precisa entrar nela também.
  if (l.length) {
    // a variável manda (como sempre), mas número de unidade configurada que ficou de fora dela é mídia/referral perdido SEM erro: avisa uma vez
    for (const n of numerosForaDaLista(l)) {
      if (avisadosForaDaLista.has(n)) continue;
      avisadosForaDaLista.add(n);
      logger.warn({ numero: n }, 'kapso: KAPSO_PHONE_NUMBER_IDS não inclui o número de uma unidade configurada — mídia e referral dela não passam por aqui');
    }
    return l;
  }
  return numerosDoKapsoConfigurados();
}

/** Quando a mensagem chegou, em segundos desde 1970: o `created_at` do webhook (ISO ou epoch em s/ms) ou da API do Chatwoot (epoch em s). null = não deu para ler. */
function segundosDe(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v > 1e11 ? v / 1000 : v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return segundosDe(n);
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > 0) return Math.floor(t / 1000);
  }
  return null;
}

/**
 * O referral que o PRÓPRIO Chatwoot trouxe (`content_attributes.referral`, desde 14/11/2026), no mesmo formato do Kapso — o da Cloud API
 * (source_type, source_id, ctwa_clid, headline, source_url, body, image_url/thumbnail_url, media_type, video_url; aceita também camelCase).
 * `criadoEm` = o `created_at` da mensagem. null = o Chatwoot não trouxe nada que identifique um anúncio/publicação (aí vale perguntar ao Kapso).
 */
export function referralDoChatwoot(ref: unknown, criadoEm?: unknown): ReferralDoKapso | null {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const r = ref as Record<string, unknown>;
  const norm = {
    source_type: r.source_type ?? r.sourceType,
    source_id: r.source_id ?? r.sourceId,
    ctwa_clid: r.ctwa_clid ?? r.ctwaClid,
    headline: r.headline,
    source_url: r.source_url ?? r.sourceUrl,
    body: r.body,
    image_url: r.image_url ?? r.imageUrl,
    thumbnail_url: r.thumbnail_url ?? r.thumbnailUrl,
    media_type: r.media_type ?? r.mediaType,
    video_url: r.video_url ?? r.videoUrl,
  };
  // source_id pode vir como número no JSON do Chatwoot
  if (typeof norm.source_id === 'number') norm.source_id = String(norm.source_id);
  const achado = referralDaMensagemDoKapso({ timestamp: segundosDe(criadoEm) ?? undefined, referral: norm });
  return achado && (achado.tipo || achado.anuncio || achado.ctwaClid) ? achado : null;
}

/**
 * Webhook do Chatwoot → mensagem de paciente na caixa oficial, com o wamid; ou null. Se o Chatwoot JÁ trouxe o referral (`referral` preenchido),
 * é esse que vale (não há o que buscar no Kapso); sem ele, `referral` é null e o chamador pergunta ao Kapso.
 */
export function mensagemParaConsultar(
  corpo: any,
  caixas: ReadonlySet<number> = CAIXAS_CLOUD,
): { conversa: number; caixa: number; wamid: string; contato: number | null; referral: ReferralDoKapso | null } | null {
  if (corpo?.event !== 'message_created') return null;
  const tipo = corpo?.message_type;
  if (!(tipo === 'incoming' || tipo === 0) || corpo?.private === true) return null;
  const caixa = Number(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id);
  const conversa = Number(corpo?.conversation?.id);
  const wamid = String(corpo?.source_id ?? '');
  if (!caixas.has(caixa) || !Number.isInteger(conversa) || conversa <= 0 || !/^wamid\.[A-Za-z0-9_=+/-]{10,400}$/.test(wamid)) return null;
  const contato = Number(corpo?.sender?.id);
  return {
    conversa,
    caixa,
    wamid,
    contato: Number.isInteger(contato) && contato > 0 ? contato : null,
    referral: referralDoChatwoot(corpo?.content_attributes?.referral, corpo?.created_at),
  };
}

/** O referral normalizado de uma mensagem do Kapso, ou null (não veio de anúncio). */
export function referralDaMensagemDoKapso(m: any): ReferralDoKapso | null {
  const r = m?.referral;
  if (!r || typeof r !== 'object') return null;
  const tipo = txt(r.source_type);
  const quando = Number(m?.timestamp) * 1000 || Date.now();
  return {
    anuncio: tipo === 'ad' ? txt(r.source_id) : null,
    ctwaClid: txt(r.ctwa_clid),
    tipo,
    titulo: txt(r.headline),
    url: txt(r.source_url),
    quando,
    corpo: longo(r.body, 3000),
    midia: longo(r.image_url, 2000) ?? longo(r.thumbnail_url, 2000),
    tipoMidia: txt(r.media_type),
    video: longo(r.video_url, 2000),
  };
}

type Buscar = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Pergunta ao Kapso por uma mensagem — NO NÚMERO DA CAIXA em que ela chegou (o `phone_number_id` da unidade dona da caixa), uma consulta só.
 * Antes era um laço sobre TODOS os números (que parava no primeiro erro): com várias clínicas, um erro no número de uma impedia achar a mensagem
 * de outra, e a mensagem de uma clínica era perguntada ao Kapso pelos números das outras. Caixa de unidade sem número do Kapso, ou número que
 * a variável `KAPSO_PHONE_NUMBER_IDS` (quando existe, ela manda) não inclui: não consulta e avisa. null = sem chave / sem número / Kapso fora
 * do ar ou recusou. Chave só no cabeçalho.
 */
export async function consultarKapso(wamid: string, caixa: number, env: NodeJS.ProcessEnv = process.env, buscar: Buscar = fetch as unknown as Buscar): Promise<{ achou: boolean; ref: ReferralDoKapso | null } | null> {
  const chave = (env.KAPSO_API_KEY ?? '').trim();
  if (!chave) return null;
  const slug = unidadeDaCaixa(caixa);
  const n = slug ? configDaUnidade(slug)?.kapsoPhoneNumberId : null;
  if (!n) {
    logger.warn({ caixa }, 'kapso-referral: a unidade desta caixa não tem número do Kapso configurado — não consulto');
    return null;
  }
  if (!numerosDoKapso(env).includes(n)) {
    logger.warn({ caixa }, 'kapso-referral: o número do Kapso desta caixa não está em KAPSO_PHONE_NUMBER_IDS — não consulto');
    return null;
  }
  try {
    const r = await buscar(`${KAPSO}/${n}/messages/${encodeURIComponent(wamid)}`, { headers: { 'X-API-Key': chave }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return { achou: false, ref: null };
    if (!r.ok) {
      logger.warn({ status: r.status, caixa }, 'kapso-referral: o Kapso recusou a consulta da mensagem');
      return null;
    }
    const j = (await r.json().catch(() => null)) as any;
    return { achou: true, ref: referralDaMensagemDoKapso(j?.data ?? j) };
  } catch (err) {
    logger.warn({ err: String(err).replace(chave, '***'), caixa }, 'kapso-referral: não consegui falar com o Kapso');
    return null;
  }
}

/** Guarda o referral da conversa (uma linha por mensagem; repetir não duplica). true = guardou agora; false = já estava guardado. */
export async function guardarReferral(caixa: number, conversa: number, wamid: string, ref: ReferralDoKapso): Promise<boolean> {
  return prisma.chatwootReguaDisparo
    .create({ data: { caixa, conversationId: conversa, regra: REGRA_KAPSO_REFERRAL, chave: wamid.slice(0, 190), modo: 'ligado', texto: JSON.stringify(ref) } })
    .then(() => true)
    .catch((err: unknown) => {
      if (String((err as { code?: unknown })?.code) !== 'P2002') throw err; // P2002 = já guardado
      return false;
    });
}

/** Os referrais guardados da conversa, do mais antigo ao mais novo. */
/** A caixa é OBRIGATÓRIA: o id da conversa é por conta do Chatwoot, e sem a caixa a leitura misturaria a conversa de outra conta. */
export async function referraisGuardados(conversa: number, caixa: number): Promise<ReferralDoKapso[]> {
  const l = await prisma.chatwootReguaDisparo.findMany({ where: { caixa, conversationId: conversa, regra: REGRA_KAPSO_REFERRAL }, select: { texto: true } }).catch(() => []);
  const saida: ReferralDoKapso[] = [];
  for (const x of l) {
    try {
      const j = JSON.parse(x.texto) as ReferralDoKapso;
      if (j && typeof j === 'object') saida.push(j);
    } catch {
      /* linha estragada: ignora */
    }
  }
  return saida.sort((a, b) => (a.quando || 0) - (b.quando || 0));
}

/** Roda para uma mensagem de paciente da caixa oficial (referral do Chatwoot, se veio; senão o do Kapso). Não lança. */
export async function aplicarReferralDoKapso(
  m: { conversa: number; caixa: number; wamid: string; contato?: number | null; /** o referral que o Chatwoot já trouxe: vale ele e o Kapso não é consultado */ referral?: ReferralDoKapso | null },
  deps: {
    consultar?: typeof consultarKapso;
    guardar?: (caixa: number, conversa: number, wamid: string, ref: ReferralDoKapso) => Promise<boolean | void>;
    /** `novo` = a linha foi guardada AGORA (a 1ª vez desta mensagem): o que só pode acontecer uma vez (a nota) olha isso */
    aoAchar?: (m: { conversa: number; caixa: number; contato: number | null }, ref: ReferralDoKapso, novo: boolean) => Promise<unknown>;
  } = {},
): Promise<'sem-chave' | 'sem-anuncio' | 'guardado' | 'falhou'> {
  try {
    const r = m.referral ? { achou: true, ref: m.referral } : await (deps.consultar ?? consultarKapso)(m.wamid, m.caixa);
    if (!r) return 'sem-chave';
    if (!r.ref) return 'sem-anuncio';
    const novo = (await (deps.guardar ?? guardarReferral)(m.caixa, m.conversa, m.wamid, r.ref)) !== false;
    // etiqueta, nota e origem (chatwoot-ia → chatwoot-origem / chatwoot-anuncio): falhar aqui não desfaz o que foi guardado
    if (deps.aoAchar) await deps.aoAchar({ conversa: m.conversa, caixa: m.caixa, contato: m.contato ?? null }, r.ref, novo).catch(() => undefined);
    logger.info({ conversa: m.conversa, anuncio: r.ref.anuncio, temClid: !!r.ref.ctwaClid }, 'kapso-referral: mensagem veio de anúncio — guardado');
    return 'guardado';
  } catch (err) {
    logger.warn({ conversa: m.conversa, err: String(err) }, 'kapso-referral: falhou');
    return 'falhou';
  }
}
