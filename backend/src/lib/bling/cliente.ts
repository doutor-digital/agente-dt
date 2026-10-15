/**
 * Leitura da API v3 do Bling com o limite da conta: 3 requisições/s e 120 mil/dia (developer.bling.com.br/limites).
 * O limite é da CONTA inteira, não do endpoint — então uma fila por unidade, com intervalo mínimo entre
 * chamadas. 429 espera e tenta de novo; 401 renova o token uma vez e tenta de novo.
 */
import { BLING_API, ErroBling, type Fetcher } from './oauth.js';
import { renovar, tokenDeAcesso, unidadePorSlug } from './conexao.js';
import { Ritmo } from './ritmo.js';

/** 3/s = uma a cada 334 ms; folga pra não encostar no limite. */
export const INTERVALO_MS = 360;

const ritmos = new Map<string, Ritmo>();
function ritmoDa(unitId: string): Ritmo {
  let r = ritmos.get(unitId);
  if (!r) ritmos.set(unitId, (r = new Ritmo(INTERVALO_MS)));
  return r;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET na API do Bling. `caminho` começa com "/" (ex. "/pedidos/vendas"). Devolve o JSON. */
export async function blingGet<T = unknown>(
  unitId: string,
  caminho: string,
  query: Record<string, string | number | undefined> = {},
  fetcher: Fetcher = fetch,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.append(k, String(v));
  const url = `${BLING_API}${caminho}${q.size ? `?${q.toString()}` : ''}`;

  let token = await tokenDeAcesso(unitId, fetcher);
  let renovou = false;
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    await ritmoDa(unitId).vez();
    let resp: Response;
    try {
      resp = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (tentativa < 3) { await dormir(1000 * (tentativa + 1)); continue; }
      throw new ErroBling(`sem resposta do Bling em ${caminho}: ${String(err).slice(0, 200)}`, null);
    }
    if (resp.status === 429) {
      // Respeita o Retry-After do Bling (segundos); sem ele, espera crescente. Teto de 30 s por espera.
      const ra = Number(resp.headers.get('retry-after'));
      await dormir(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1100 * (tentativa + 1), 30_000));
      continue;
    }
    if (resp.status === 401 && !renovou) { renovou = true; token = await renovar(unitId, fetcher); continue; }
    const texto = await resp.text();
    if (!resp.ok) {
      if (resp.status >= 500 && tentativa < 3) { await dormir(1000 * (tentativa + 1)); continue; }
      throw new ErroBling(`Bling ${resp.status} em ${caminho}: ${texto.slice(0, 300)}`, resp.status);
    }
    return (texto ? JSON.parse(texto) : null) as T;
  }
  throw new ErroBling(`Bling não respondeu em ${caminho} depois de 4 tentativas (limite de requisições?)`, 429);
}

/** Prova que a conexão funciona: lê os dados básicos da empresa no Bling e devolve o nome. */
export async function testarConexao(slug: string, fetcher: Fetcher = fetch): Promise<string | null> {
  const u = await unidadePorSlug(slug);
  const r = await blingGet<{ data?: { nome?: string; fantasia?: string } }>(u.id, '/empresas/me/dados-basicos', {}, fetcher);
  return r?.data?.fantasia || r?.data?.nome || null;
}
