/**
 * De qual conta de anúncios é um anúncio — pergunta à Meta (Graph `GET /{ad_id}?fields=account_id`).
 *
 * Serve ao robô da unidade de atendimento (Petrópolis × Caxias no mesmo número): anúncio novo entra sozinho,
 * sem alguém manter lista. Precisa do token da unidade com acesso de leitura à conta de anúncios; sem token,
 * ou sem acesso, devolve null e o robô cai para a lista conferida à mão e depois para o DDD.
 *
 * Cache em memória: a conta de um anúncio não muda (24 h); a falta de acesso pode mudar quando alguém libera
 * a conta no Business Manager (1 h).
 */
import { logger } from './logger.js';

const GRAPH = 'https://graph.facebook.com/v25.0';
const TTL_ACHOU_MS = 24 * 60 * 60_000;
const TTL_FALHOU_MS = 60 * 60_000;

const cache = new Map<string, { conta: string | null; ate: number }>();

export async function contaDoAnuncio(anuncio: string, token: string | null | undefined): Promise<string | null> {
  if (!token || !/^\d+$/.test(anuncio)) return null;
  const hit = cache.get(anuncio);
  if (hit && hit.ate > Date.now()) return hit.conta;

  let conta: string | null = null;
  try {
    const r = await fetch(`${GRAPH}/${anuncio}?fields=account_id`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => null)) as { account_id?: unknown; error?: { message?: string } } | null;
    if (r.ok && typeof j?.account_id === 'string') conta = j.account_id.replace(/^act_/, '');
    else logger.info({ anuncio, status: r.status, erro: j?.error?.message?.slice(0, 120) }, 'conta-do-anuncio: a Meta não deixou ver');
  } catch (err) {
    logger.warn({ anuncio, err: String(err) }, 'conta-do-anuncio: falha ao perguntar à Meta');
  }
  cache.set(anuncio, { conta, ate: Date.now() + (conta ? TTL_ACHOU_MS : TTL_FALHOU_MS) });
  return conta;
}
