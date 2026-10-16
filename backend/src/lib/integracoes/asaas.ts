/**
 * Leitura da API v3 do Asaas (api.asaas.com) com a chave da conta. SÓ GET: este cliente não tem como
 * criar cobrança, transferir ou estornar — a chave do Asaas pode tudo isso, o conector não.
 *
 * Uma fila por conta (o Asaas limita requisições por chave) e nova tentativa em 429/5xx. GET com corpo
 * volta 403 no Asaas: nunca mandamos corpo.
 */
import { Ritmo } from '../bling/ritmo.js';

export const ASAAS_API = process.env.ASAAS_API_URL || 'https://api.asaas.com/v3';
const AGENTE = 'DoutorDigital-Conector/1.0';

export class ErroAsaas extends Error {
  constructor(msg: string, readonly status: number | null) {
    super(msg);
  }
}

type Fetcher = typeof fetch;
const ritmos = new Map<string, Ritmo>();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET no Asaas. `contaId` separa a fila de cada conta; `caminho` começa com "/". */
export async function asaasGet<T = unknown>(
  contaId: string,
  chave: string,
  caminho: string,
  query: Record<string, string | number | undefined> = {},
  fetcher: Fetcher = fetch,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.append(k, String(v));
  const url = `${ASAAS_API}${caminho}${q.size ? `?${q.toString()}` : ''}`;
  let ritmo = ritmos.get(contaId);
  if (!ritmo) ritmos.set(contaId, (ritmo = new Ritmo(250)));
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    await ritmo.vez();
    let resp: Response;
    try {
      resp = await fetcher(url, { method: 'GET', headers: { access_token: chave, 'User-Agent': AGENTE, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (tentativa < 3) { await dormir(1000 * (tentativa + 1)); continue; }
      throw new ErroAsaas(`sem resposta do Asaas em ${caminho}: ${String(err).slice(0, 200)}`, null);
    }
    if (resp.status === 429 || resp.status >= 500) {
      if (tentativa < 3) { await dormir(Math.min(1500 * (tentativa + 1), 10_000)); continue; }
    }
    const texto = await resp.text();
    if (resp.status === 401) throw new ErroAsaas('o Asaas recusou a chave (401): chave errada, revogada ou de outro ambiente (sandbox × produção)', 401);
    if (!resp.ok) throw new ErroAsaas(`Asaas ${resp.status} em ${caminho}: ${texto.slice(0, 300)}`, resp.status);
    return (texto ? JSON.parse(texto) : null) as T;
  }
  throw new ErroAsaas(`Asaas não respondeu em ${caminho} depois de 4 tentativas`, 429);
}

/** Prova a chave: lê o saldo e o nome comercial da conta. Devolve o nome para mostrar no painel. */
export async function testarChaveAsaas(chave: string, fetcher: Fetcher = fetch): Promise<string> {
  await asaasGet('teste', chave, '/finance/balance', {}, fetcher);
  try {
    const info = await asaasGet<{ companyName?: string; name?: string; cpfCnpj?: string }>('teste', chave, '/myAccount/commercialInfo', {}, fetcher);
    return info?.companyName || info?.name || 'conta Asaas';
  } catch {
    return 'conta Asaas';
  }
}
