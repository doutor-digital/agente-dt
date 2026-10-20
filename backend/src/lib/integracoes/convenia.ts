/**
 * Leitura da API pública v3 do Convênia (RH/departamento pessoal) com o token da empresa. SÓ GET: o token
 * do Convênia pode admitir, desligar e apagar falta — este cliente não tem como.
 *
 * Limite do Convênia: 50 requisições por minuto por token (429 com Retry-After). A janela daqui deixa
 * folga (45/min) e uma nova tentativa respeita o Retry-After.
 */
import { dormir, type Dormir } from '../../franquia-mcp/ritmo.js';

export const CONVENIA_API = process.env.CONVENIA_API_URL || 'https://public-api.convenia.com.br/api/v3';
const AGENTE = 'DoutorDigital-Conector/1.0';

export class ErroConvenia extends Error {
  constructor(msg: string, readonly status: number | null) {
    super(msg);
  }
}

/**
 * No máximo `max` saídas em qualquer janela de `janelaMs`. Diferente de um intervalo fixo, deixa a rajada
 * pequena sair de uma vez (empresa de 10 pessoas responde na hora) e só segura quando encosta no teto.
 */
export class JanelaDeRitmo {
  private saidas: number[] = [];
  constructor(
    readonly max: number,
    readonly janelaMs: number,
    private readonly agora: () => number = Date.now,
    private readonly esperar: Dormir = dormir,
  ) {}

  async vez(): Promise<void> {
    for (;;) {
      const t = this.agora();
      this.saidas = this.saidas.filter((s) => t - s < this.janelaMs);
      if (this.saidas.length < this.max) {
        this.saidas.push(t);
        return;
      }
      await this.esperar(this.saidas[0]! + this.janelaMs - t);
    }
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

/** GET no Convênia. `contaId` separa a janela de cada token; `caminho` começa com "/". */
export async function conveniaGet<T = unknown>(
  contaId: string,
  token: string,
  caminho: string,
  query: Record<string, string | number | undefined> = {},
  fetcher: Fetcher = fetch,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.append(k, String(v));
  const url = `${CONVENIA_API}${caminho}${q.size ? `?${q.toString()}` : ''}`;
  let janela = janelas.get(contaId);
  if (!janela) janelas.set(contaId, (janela = new JanelaDeRitmo(45, 60_000)));
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    await janela.vez();
    let resp: Response;
    try {
      resp = await fetcher(url, { method: 'GET', headers: { token, 'User-Agent': AGENTE, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (tentativa < 3) { await dormir(1000 * (tentativa + 1)); continue; }
      throw new ErroConvenia(`sem resposta do Convênia em ${caminho}: ${String(err).slice(0, 200)}`, null);
    }
    if ((resp.status === 429 || resp.status >= 500) && tentativa < 3) {
      await dormir(resp.status === 429 ? esperaPedida(resp, tentativa) : 1500 * (tentativa + 1));
      continue;
    }
    const texto = await resp.text();
    if (resp.status === 401) throw new ErroConvenia('o Convênia recusou o token (401): token errado ou removido — gere outro em Configurações → API', 401);
    if (resp.status === 403) throw new ErroConvenia(`o token do Convênia não tem permissão para ${caminho} (403): edite o token em Configurações → API e marque essa listagem`, 403);
    if (!resp.ok) throw new ErroConvenia(`Convênia ${resp.status} em ${caminho}: ${texto.slice(0, 300)}`, resp.status);
    return (texto ? JSON.parse(texto) : null) as T;
  }
  throw new ErroConvenia(`Convênia não respondeu em ${caminho} depois de 4 tentativas`, 429);
}

interface DetalheDoToken {
  data?: { name?: string; permissions?: Array<{ name?: string; translated_name?: string }> };
}

/** Permissões do token que mexem em dado (o conector não usa nenhuma — só avisa no painel). */
const ESCRITA = /\.(post|put|update|delete|destroy|create|upload)[.-]/;

/**
 * Prova o token: lê o detalhe dele (nome e permissões) e exige a listagem de colaboradores. A API pública
 * do Convênia não tem rota com o nome ou o CNPJ da empresa — o que identifica a empresa é a unidade em que
 * o token é salvo. Devolve o rótulo para o painel.
 */
export async function testarChaveConvenia(token: string, fetcher: Fetcher = fetch): Promise<string> {
  const r = await conveniaGet<DetalheDoToken>('teste', token, '/tokens/permissions', { paginate: 500 }, fetcher);
  const perms = (r?.data?.permissions ?? []).map((p) => String(p.name ?? ''));
  if (!perms.includes('employees.get.employees')) {
    throw new ErroConvenia('o token do Convênia não tem a permissão "Listagem de colaboradores": edite o token e marque essa listagem', 403);
  }
  const nome = r?.data?.name?.trim();
  const escrita = perms.some((p) => ESCRITA.test(p));
  return `Convênia · token ${nome ? `"${nome}"` : 'sem nome'}${escrita ? ' · o token também altera dados (o conector só lê)' : ''}`;
}
