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
import { numerosDoKapsoConfigurados } from './chatwoot-unidades.js';

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

export function numerosDoKapso(env: NodeJS.ProcessEnv = process.env): string[] {
  const l = String(env.KAPSO_PHONE_NUMBER_IDS ?? '').split(/[\s,]+/).filter((x) => /^\d{5,25}$/.test(x));
  // a variável de ambiente, SE existir, manda (como sempre); sem ela valem os números das unidades configuradas (Parauapebas é a semente,
  // que era o padrão). Atenção ao ligar unidade nova: com KAPSO_PHONE_NUMBER_IDS definida, o número dela precisa entrar nela também.
  return l.length ? l : numerosDoKapsoConfigurados();
}

/** Webhook do Chatwoot → mensagem de paciente na caixa oficial, SEM referral, com o wamid; ou null. */
export function mensagemParaConsultar(corpo: any, caixas: ReadonlySet<number> = CAIXAS_CLOUD): { conversa: number; caixa: number; wamid: string; contato: number | null } | null {
  if (corpo?.event !== 'message_created') return null;
  const tipo = corpo?.message_type;
  if (!(tipo === 'incoming' || tipo === 0) || corpo?.private === true) return null;
  const caixa = Number(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id);
  const conversa = Number(corpo?.conversation?.id);
  const wamid = String(corpo?.source_id ?? '');
  if (!caixas.has(caixa) || !Number.isInteger(conversa) || conversa <= 0 || !/^wamid\.[A-Za-z0-9_=+/-]{10,400}$/.test(wamid)) return null;
  const ref = corpo?.content_attributes?.referral;
  if (ref && typeof ref === 'object' && Object.keys(ref).length) return null; // o Chatwoot já tem: nada a buscar
  const contato = Number(corpo?.sender?.id);
  return { conversa, caixa, wamid, contato: Number.isInteger(contato) && contato > 0 ? contato : null };
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

/** Pergunta ao Kapso por uma mensagem (tenta cada número). null = sem chave / Kapso não achou / fora do ar. Chave só no cabeçalho. */
export async function consultarKapso(wamid: string, env: NodeJS.ProcessEnv = process.env, buscar: Buscar = fetch as unknown as Buscar): Promise<{ achou: boolean; ref: ReferralDoKapso | null } | null> {
  const chave = (env.KAPSO_API_KEY ?? '').trim();
  if (!chave) return null;
  for (const n of numerosDoKapso(env)) {
    try {
      const r = await buscar(`${KAPSO}/${n}/messages/${encodeURIComponent(wamid)}`, { headers: { 'X-API-Key': chave }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 404) continue;
      if (!r.ok) {
        logger.warn({ status: r.status }, 'kapso-referral: o Kapso recusou a consulta da mensagem');
        return null;
      }
      const j = (await r.json().catch(() => null)) as any;
      return { achou: true, ref: referralDaMensagemDoKapso(j?.data ?? j) };
    } catch (err) {
      logger.warn({ err: String(err).replace(chave, '***') }, 'kapso-referral: não consegui falar com o Kapso');
      return null;
    }
  }
  return { achou: false, ref: null };
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
export async function referraisGuardados(conversa: number): Promise<ReferralDoKapso[]> {
  const l = await prisma.chatwootReguaDisparo.findMany({ where: { conversationId: conversa, regra: REGRA_KAPSO_REFERRAL }, select: { texto: true } }).catch(() => []);
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

/** Roda para uma mensagem de paciente da caixa oficial. Não lança. */
export async function aplicarReferralDoKapso(
  m: { conversa: number; caixa: number; wamid: string; contato?: number | null },
  deps: {
    consultar?: typeof consultarKapso;
    guardar?: (caixa: number, conversa: number, wamid: string, ref: ReferralDoKapso) => Promise<boolean | void>;
    /** `novo` = a linha foi guardada AGORA (a 1ª vez desta mensagem): o que só pode acontecer uma vez (a nota) olha isso */
    aoAchar?: (m: { conversa: number; caixa: number; contato: number | null }, ref: ReferralDoKapso, novo: boolean) => Promise<unknown>;
  } = {},
): Promise<'sem-chave' | 'sem-anuncio' | 'guardado' | 'falhou'> {
  try {
    const r = await (deps.consultar ?? consultarKapso)(m.wamid);
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
