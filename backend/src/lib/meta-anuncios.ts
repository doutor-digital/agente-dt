/**
 * Quanto a conta de anúncios da unidade GASTOU no período, por anúncio (Graph `GET /act_<conta>/insights?level=ad`). Só leitura.
 * Alimenta o «Investido» do painel do gestor no Chatwoot.
 *
 * O token e a conta vêm do ambiente, nunca do código: `META_ADS_TOKEN_<UNIDADE>` e `META_ADS_CONTA_<UNIDADE>` (o mesmo nome do token
 * que o rastreio de campanhas já usa; ver `credenciaisDeAnuncio`). Sem eles a tela mostra «conectar a conta de anúncios». O token
 * vai no cabeçalho Authorization (nunca na URL) e nunca entra em log. Cache de 10 min por conta e período: o gestor atualizando a
 * tela não vira rajada na Meta.
 */
import { logger } from './logger.js';
import type { LinhaAnuncio } from './chatwoot-gestor.js';

const GRAPH = `${process.env.META_GRAPH_URL || 'https://graph.facebook.com'}/${process.env.META_GRAPH_VERSION || 'v23.0'}`;
const VALE_MS = 10 * 60_000;
const MAX_PAGINAS = 8;

export type GastoDaConta = { ok: true; linhas: LinhaAnuncio[]; total: number; moeda: string | null; /** a leitura parou no limite de páginas: o total pode estar abaixo do real */ parcial: boolean } | { ok: false; motivo: string };

const cache = new Map<string, { ate: number; v: GastoDaConta }>();
export function limparCacheDeAnuncios(): void {
  cache.clear();
  cacheDiario.clear();
  cacheDestinos.clear();
}

type Buscar = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A «conversa iniciada» que o Gerenciador de Anúncios mostra como resultado das campanhas de WhatsApp. */
export const ACAO_CONVERSA = 'onsite_conversion.messaging_conversation_started_7d';
/** Lead de formulário instantâneo. */
export const ACAO_LEAD = 'lead';
const inteiro = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
/** `actions` do insights (`[{ action_type, value }]`) → { tipo: quantidade }. */
export function acoesDoAnuncio(v: unknown): Record<string, number> {
  const r: Record<string, number> = {};
  for (const a of Array.isArray(v) ? (v as Array<{ action_type?: unknown; value?: unknown }>) : []) {
    if (typeof a?.action_type === 'string') r[a.action_type] = inteiro(a.value);
  }
  return r;
}

export type DestinosDaConta = { ok: true; porCampanha: Map<string, string[]> } | { ok: false; motivo: string };
const cacheDestinos = new Map<string, { ate: number; v: DestinosDaConta }>();

/**
 * Para qual WhatsApp cada campanha manda a pessoa (`promoted_object.whatsapp_phone_number` dos conjuntos). É o que explica, na tela,
 * por que um lead de anúncio não aparece no Chatwoot: o anúncio leva para um número que não está numa caixa. Cache de 30 min.
 */
export async function destinosDaConta(conta: string, token: string, buscar: Buscar = fetch as unknown as Buscar, agora: () => number = Date.now): Promise<DestinosDaConta> {
  const hit = cacheDestinos.get(conta);
  if (hit && hit.ate > agora()) return hit.v;
  const porCampanha = new Map<string, string[]>();
  let url: string | null = `${GRAPH}/act_${conta}/adsets?${new URLSearchParams({ fields: 'campaign_id,promoted_object', limit: '200' })}`;
  try {
    for (let p = 0; p < MAX_PAGINAS && url; p++) {
      const r = await buscar(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      const j = (await r.json().catch(() => null)) as { data?: unknown; paging?: { next?: unknown } } | null;
      if (!r.ok) {
        logger.warn({ conta, status: r.status }, 'meta-anuncios: a Meta recusou a leitura dos conjuntos');
        return { ok: false, motivo: `a Meta não deixou ler os conjuntos (HTTP ${r.status})` };
      }
      for (const x of Array.isArray(j?.data) ? (j!.data as Array<{ campaign_id?: unknown; promoted_object?: { whatsapp_phone_number?: unknown } }>) : []) {
        const campanha = String(x.campaign_id ?? '');
        const numero = String(x.promoted_object?.whatsapp_phone_number ?? '').replace(/\D/g, '');
        if (!/^\d+$/.test(campanha) || numero.length < 10) continue;
        const l = porCampanha.get(campanha) ?? [];
        if (!l.includes(numero)) l.push(numero);
        porCampanha.set(campanha, l);
      }
      const prox = typeof j?.paging?.next === 'string' ? j.paging.next : null;
      url = prox && prox.startsWith(`${new URL(GRAPH).origin}/`) ? prox : null;
    }
  } catch (err) {
    logger.warn({ conta, err: String(err).replace(token, '***') }, 'meta-anuncios: falha ao ler os conjuntos');
    return { ok: false, motivo: 'não consegui falar com a Meta agora' };
  }
  const v: DestinosDaConta = { ok: true, porCampanha };
  cacheDestinos.set(conta, { ate: agora() + 30 * 60_000, v });
  if (cacheDestinos.size > 100) cacheDestinos.clear();
  return v;
}

export async function gastoDaConta(
  conta: string,
  token: string,
  de: string,
  ate: string,
  buscar: Buscar = fetch as unknown as Buscar,
  agora: () => number = Date.now,
): Promise<GastoDaConta> {
  const chave = `${conta}|${de}|${ate}`;
  const hit = cache.get(chave);
  if (hit && hit.ate > agora()) return hit.v;
  const linhas: LinhaAnuncio[] = [];
  let moeda: string | null = null;
  const params = new URLSearchParams({
    level: 'ad',
    fields: 'ad_id,ad_name,campaign_id,campaign_name,objective,spend,impressions,clicks,actions,account_currency',
    time_range: JSON.stringify({ since: de, until: ate }),
    limit: '200',
  });
  let url: string | null = `${GRAPH}/act_${conta}/insights?${params}`;
  try {
    for (let p = 0; p < MAX_PAGINAS && url; p++) {
      const r = await buscar(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      const j = (await r.json().catch(() => null)) as { data?: unknown; paging?: { next?: unknown }; error?: { message?: unknown; code?: unknown } } | null;
      if (!r.ok) {
        // 4xx = a Meta respondeu «não» (token vencido, sem permissão, conta errada): é motivo para a tela, não para tentar de novo agora
        const codigo = j?.error?.code !== undefined ? ` (#${String(j.error.code)})` : '';
        const motivo = r.status === 401 || r.status === 403 || j?.error?.code === 190 ? `a Meta recusou o token${codigo}` : r.status === 400 ? `a Meta não aceitou o pedido${codigo} — confira a conta de anúncios` : `a Meta não respondeu direito (HTTP ${r.status})`;
        logger.warn({ conta, status: r.status, codigo: j?.error?.code }, 'meta-anuncios: a Meta recusou a leitura do gasto');
        const v: GastoDaConta = { ok: false, motivo };
        if (r.status >= 400 && r.status < 500 && r.status !== 429) cache.set(chave, { ate: agora() + 60_000, v });
        return v;
      }
      for (const x of Array.isArray(j?.data) ? (j!.data as Array<Record<string, unknown>>) : []) {
        const gasto = Number(x.spend);
        const anuncioId = String(x.ad_id ?? '');
        const campanhaId = String(x.campaign_id ?? '');
        if (!/^\d+$/.test(anuncioId) || !/^\d+$/.test(campanhaId) || !Number.isFinite(gasto)) continue;
        if (typeof x.account_currency === 'string') moeda = x.account_currency;
        const acoes = acoesDoAnuncio(x.actions);
        linhas.push({
          anuncioId,
          anuncioNome: String(x.ad_name ?? '').slice(0, 140),
          campanhaId,
          campanhaNome: String(x.campaign_name ?? '').slice(0, 140),
          gasto,
          objetivo: typeof x.objective === 'string' ? x.objective : null,
          conversas: acoes[ACAO_CONVERSA] ?? 0,
          leadsMeta: acoes[ACAO_LEAD] ?? 0,
          impressoes: inteiro(x.impressions),
          cliques: inteiro(x.clicks),
        });
      }
      // a próxima página só vale se for do próprio Graph (o token vai junto)
      const prox = typeof j?.paging?.next === 'string' ? j.paging.next : null;
      url = prox && prox.startsWith(`${new URL(GRAPH).origin}/`) ? prox : null;
    }
  } catch (err) {
    logger.warn({ conta, err: String(err).replace(token, '***') }, 'meta-anuncios: falha ao ler o gasto');
    return { ok: false, motivo: 'não consegui falar com a Meta agora' };
  }
  const total = Math.round(linhas.reduce((t, l) => t + l.gasto, 0) * 100) / 100;
  const v: GastoDaConta = { ok: true, linhas, total, moeda, parcial: !!url };
  cache.set(chave, { ate: agora() + VALE_MS, v });
  if (cache.size > 200) cache.clear();
  return v;
}

export type GastoDiario = { ok: true; porDia: Record<string, number>; total: number } | { ok: false; motivo: string };
const cacheDiario = new Map<string, { ate: number; v: GastoDiario }>();

/** O gasto da conta por DIA (nível conta, `time_increment=1`): alimenta o gráfico e o total do período anterior. */
export async function gastoDiarioDaConta(
  conta: string,
  token: string,
  de: string,
  ate: string,
  buscar: Buscar = fetch as unknown as Buscar,
  agora: () => number = Date.now,
): Promise<GastoDiario> {
  const chave = `${conta}|${de}|${ate}`;
  const hit = cacheDiario.get(chave);
  if (hit && hit.ate > agora()) return hit.v;
  const params = new URLSearchParams({ level: 'account', fields: 'spend,date_start', time_increment: '1', time_range: JSON.stringify({ since: de, until: ate }), limit: '100' });
  try {
    const r = await buscar(`${GRAPH}/act_${conta}/insights?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const j = (await r.json().catch(() => null)) as { data?: unknown } | null;
    if (!r.ok) return { ok: false, motivo: `a Meta não respondeu direito (HTTP ${r.status})` };
    const porDia: Record<string, number> = {};
    for (const x of Array.isArray(j?.data) ? (j!.data as Array<Record<string, unknown>>) : []) {
      const dia = String(x.date_start ?? '');
      const gasto = Number(x.spend);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dia) && Number.isFinite(gasto)) porDia[dia] = Math.round(((porDia[dia] ?? 0) + gasto) * 100) / 100;
    }
    const total = Math.round(Object.values(porDia).reduce((t, v) => t + v, 0) * 100) / 100;
    const v: GastoDiario = { ok: true, porDia, total };
    cacheDiario.set(chave, { ate: agora() + VALE_MS, v });
    if (cacheDiario.size > 200) cacheDiario.clear();
    return v;
  } catch (err) {
    logger.warn({ conta, err: String(err).replace(token, '***') }, 'meta-anuncios: falha ao ler o gasto diário');
    return { ok: false, motivo: 'não consegui falar com a Meta agora' };
  }
}
