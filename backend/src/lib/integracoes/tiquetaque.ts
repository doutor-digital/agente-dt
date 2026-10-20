/**
 * Leitura da API pública v2.1 do Tiquetaque (ponto eletrônico) com o token da conta. SÓ GET: o token do
 * Tiquetaque também cria batida, funcionário e afastamento — este cliente não tem como.
 *
 * Autenticação: HTTP Basic com usuário fixo "public" e o token como senha (doc oficial:
 * https://api-docs.tiquetaque.app/openapi). Limite: 60 requisições por janela deslizante de 1 minuto por
 * token (429). A janela daqui deixa folga (55/min) e uma nova tentativa respeita o Retry-After.
 */
import { JanelaDeRitmo } from './convenia.js';
import { dormir } from '../../franquia-mcp/ritmo.js';

export const TIQUETAQUE_API = process.env.TIQUETAQUE_API_URL || 'https://api.tiquetaque.com/v2.1';
const AGENTE = 'DoutorDigital-Conector/1.0';

export class ErroTiquetaque extends Error {
  constructor(msg: string, readonly status: number | null) {
    super(msg);
  }
}

type Fetcher = typeof fetch;
const janelas = new Map<string, JanelaDeRitmo>();

/** Retry-After em segundos (ou data HTTP), com teto de 60 s. */
function esperaPedida(resp: Response, tentativa: number): number {
  const ra = resp.headers.get('retry-after');
  const s = ra ? Number(ra) : NaN;
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 60_000);
  const d = ra ? Date.parse(ra) : NaN;
  if (Number.isFinite(d)) return Math.min(Math.max(d - Date.now(), 0), 60_000);
  return Math.min(2000 * (tentativa + 1), 10_000);
}

/** A mensagem que o Tiquetaque (Eve) põe em `_error`, sem nada do pedido. */
function mensagemDoErro(texto: string): string {
  try {
    const e = (JSON.parse(texto) as { _error?: { message?: unknown; ui_message?: unknown } })?._error;
    const m = typeof e?.ui_message === 'string' ? e.ui_message : typeof e?.message === 'string' ? e.message : '';
    if (m) return m.slice(0, 300);
  } catch {
    // não é JSON: cai no texto cru
  }
  return texto.slice(0, 300);
}

/** GET no Tiquetaque. `contaId` separa a janela de cada token; `caminho` começa com "/". */
export async function tiquetaqueGet<T = unknown>(
  contaId: string,
  token: string,
  caminho: string,
  query: Record<string, string | number | undefined> = {},
  fetcher: Fetcher = fetch,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.append(k, String(v));
  const url = `${TIQUETAQUE_API}${caminho}${q.size ? `?${q.toString()}` : ''}`;
  const autorizacao = `Basic ${Buffer.from(`public:${token}`).toString('base64')}`;
  let janela = janelas.get(contaId);
  if (!janela) janelas.set(contaId, (janela = new JanelaDeRitmo(55, 60_000)));
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    await janela.vez();
    let resp: Response;
    try {
      resp = await fetcher(url, {
        method: 'GET',
        headers: { Authorization: autorizacao, 'User-Agent': AGENTE, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (tentativa < 3) { await dormir(1000 * (tentativa + 1)); continue; }
      throw new ErroTiquetaque(`sem resposta do Tiquetaque em ${caminho}: ${String(err).slice(0, 200)}`, null);
    }
    if ((resp.status === 429 || resp.status >= 500) && tentativa < 3) {
      await dormir(resp.status === 429 ? esperaPedida(resp, tentativa) : 1500 * (tentativa + 1));
      continue;
    }
    const texto = await resp.text();
    if (resp.status === 401) {
      throw new ErroTiquetaque('o Tiquetaque recusou o token (401): token errado ou removido — gere outro no TiqueAdmin em Configurações → Integrações → API pública', 401);
    }
    if (resp.status === 403) throw new ErroTiquetaque(`o token do Tiquetaque não tem acesso a ${caminho} (403)`, 403);
    if (!resp.ok) throw new ErroTiquetaque(`Tiquetaque ${resp.status} em ${caminho}: ${mensagemDoErro(texto)}`, resp.status);
    if (!texto) return null as T;
    try {
      return JSON.parse(texto) as T;
    } catch {
      throw new ErroTiquetaque(`Tiquetaque ${resp.status} em ${caminho}: resposta que não é JSON (${texto.slice(0, 120)})`, resp.status);
    }
  }
  throw new ErroTiquetaque(`Tiquetaque não respondeu em ${caminho} depois de 4 tentativas`, 429);
}

interface ListaEve<T> {
  _items?: T[] | null;
  _meta?: { total?: number } | null;
}

/**
 * Prova o token: lê os empregadores da conta (razão social) e quantos funcionários ativos ela tem. Devolve
 * o rótulo para o painel — só razão social e contagem; CNPJ e endereço do empregador não saem.
 */
export async function testarChaveTiquetaque(token: string, fetcher: Fetcher = fetch): Promise<string> {
  const emp = await tiquetaqueGet<ListaEve<{ name?: unknown }>>('teste', token, '/payment-sources', { max_results: 50 }, fetcher);
  const nomes = (emp?._items ?? []).map((e) => (typeof e.name === 'string' ? e.name.trim() : '')).filter(Boolean);
  const func = await tiquetaqueGet<ListaEve<unknown>>('teste', token, '/employees', { max_results: 1 }, fetcher);
  const total = Number(func?._meta?.total);
  const empresas = nomes.length ? (nomes.length > 3 ? `${nomes.slice(0, 3).join(' + ')} + ${nomes.length - 3}` : nomes.join(' + ')) : 'conta sem empregador cadastrado';
  return `Tiquetaque · ${empresas}${Number.isFinite(total) ? ` · ${total} funcionários ativos` : ''}`.slice(0, 250);
}
