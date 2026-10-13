/**
 * De qual conta de anúncios é um anúncio — pergunta à Meta (Graph `GET /{ad_id}?fields=account_id`).
 *
 * Serve ao robô da unidade de atendimento (Petrópolis × Caxias no mesmo número): anúncio novo entra sozinho,
 * sem alguém manter lista. Precisa do token da unidade com acesso de leitura à conta de anúncios; sem token,
 * ou sem acesso, devolve `conta: null` e o robô cai para a lista conferida à mão e depois para o DDD.
 *
 * `falhou: true` = a Meta não respondeu (rede, tempo, 5xx, limite): quem chama NÃO deve decidir com o DDD nessa
 * rodada, senão um soluço da Meta troca a unidade e a próxima rodada destroca. Falha não vai pro cache.
 * Cache: a conta de um anúncio não muda (24 h); "sem acesso" pode mudar quando alguém libera a conta (1 h).
 */
import { logger } from './logger.js';

const GRAPH = `${process.env.META_GRAPH_URL || 'https://graph.facebook.com'}/${process.env.META_GRAPH_VERSION || 'v23.0'}`;
const TTL_ACHOU_MS = 24 * 60 * 60_000;
const TTL_SEM_ACESSO_MS = 60 * 60_000;

const cache = new Map<string, { conta: string | null; ate: number }>();

export interface ContaDoAnuncio {
  conta: string | null;
  falhou: boolean;
}

export async function contaDoAnuncio(anuncio: string, token: string | null | undefined): Promise<ContaDoAnuncio> {
  if (!token || !/^\d+$/.test(anuncio)) return { conta: null, falhou: false };
  const hit = cache.get(anuncio);
  if (hit && hit.ate > Date.now()) return { conta: hit.conta, falhou: false };
  if (hit) cache.delete(anuncio);

  try {
    const r = await fetch(`${GRAPH}/${anuncio}?fields=account_id`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => null)) as { account_id?: unknown; error?: { message?: string } } | null;
    if (r.ok && typeof j?.account_id === 'string') {
      const conta = j.account_id.replace(/^act_/, '');
      cache.set(anuncio, { conta, ate: Date.now() + TTL_ACHOU_MS });
      return { conta, falhou: false };
    }
    // 400/403/404 = o anúncio não existe ou o token não enxerga a conta: resposta de verdade, vai pro cache
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      logger.info({ anuncio, status: r.status, erro: j?.error?.message?.slice(0, 120) }, 'conta-do-anuncio: a Meta não deixou ver');
      cache.set(anuncio, { conta: null, ate: Date.now() + TTL_SEM_ACESSO_MS });
      return { conta: null, falhou: false };
    }
    logger.warn({ anuncio, status: r.status }, 'conta-do-anuncio: a Meta não respondeu direito — tento na próxima rodada');
  } catch (err) {
    logger.warn({ anuncio, err: String(err) }, 'conta-do-anuncio: falha ao perguntar à Meta — tento na próxima rodada');
  }
  return { conta: null, falhou: true };
}
