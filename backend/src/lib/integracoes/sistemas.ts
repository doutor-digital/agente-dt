/**
 * Cliente da API de administração do sistema novo de RH/Caixa/Financeiro (`/admin/v1`, servidor próprio, fora do
 * Supabase). Só o conector do claude.ai chama; a rota só existe na rede interna do Swarm (`http://api-rh:8080`).
 *
 * A "chave" que o painel de integrações guarda para este provedor é um JSON de uma linha:
 *   {"api":"http://api-rh:8080","chave":"<ADMIN_KEY>","tela":"https://<endereço da tela RH>"}
 * `api` = URL base da API de administração; `chave` = ADMIN_KEY do servidor (cabeçalho `x-admin-key`); `tela` = endereço
 * da tela RH, para montar o link de convite (opcional). A chave nunca sai daqui: nem em resposta, nem em mensagem de erro.
 *
 * Contrato: docs/ADMIN-API.md do repositório do sistema novo (sistemas-dd).
 */

export interface ConfigSistemas {
  /** URL base da API, sem barra no fim (ex. http://api-rh:8080) */
  api: string;
  chave: string;
  /** endereço público da tela RH (para o link de convite) */
  tela?: string;
}

export class ErroSistemas extends Error {
  constructor(msg: string, readonly status: number | null) {
    super(msg);
  }
}

const FORMATO = 'cole o JSON de uma linha: {"api":"http://api-rh:8080","chave":"<ADMIN_KEY do servidor>","tela":"https://<endereço da tela RH>"}';

function urlHttp(bruta: unknown, campo: string): URL {
  let u: URL;
  try {
    u = new URL(String(bruta ?? ''));
  } catch {
    throw new Error(`"${campo}" não é um endereço válido (${FORMATO})`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`"${campo}" precisa começar com http:// ou https://`);
  if (u.username || u.password) throw new Error(`"${campo}" não pode levar usuário e senha no endereço`);
  return u;
}

/** Lê e valida o JSON guardado. A mensagem de erro nunca repete o conteúdo colado (a chave está nele). */
export function lerConfigSistemas(texto: string): ConfigSistemas {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new Error(`o conteúdo não é um JSON válido: ${FORMATO}`);
  }
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new Error(`o conteúdo não é um objeto JSON: ${FORMATO}`);
  const o = bruto as Record<string, unknown>;
  const api = urlHttp(o.api, 'api');
  if (api.search || api.hash) throw new Error('"api" não pode ter ? nem # (só o endereço base)');
  const chave = typeof o.chave === 'string' ? o.chave.trim() : '';
  if (chave.length < 16) throw new Error('"chave" ausente ou curta demais: é a ADMIN_KEY do servidor, copiada inteira');
  const cfg: ConfigSistemas = { api: api.toString().replace(/\/+$/, ''), chave };
  if (o.tela !== undefined && o.tela !== null && String(o.tela).trim() !== '') {
    const tela = urlHttp(o.tela, 'tela');
    cfg.tela = tela.toString();
  }
  return cfg;
}

type Fetcher = typeof fetch;

/** Tira da mensagem tudo que não pode sair: a chave e o endereço interno do servidor. */
function limpar(texto: string, cfg: ConfigSistemas): string {
  let t = texto;
  const segredos = [cfg.chave, cfg.api, (() => { try { return new URL(cfg.api).host; } catch { return ''; } })()].filter((s) => s.length >= 4);
  for (const s of segredos) t = t.split(s).join('[oculto]');
  return t;
}

/** O servidor aceita o autor em cabeçalho; nome com acento não cabe em cabeçalho HTTP, então vai codificado. */
function cabecalhoQuem(quem: string): string {
  return /^[\x20-\x7e]*$/.test(quem) ? quem : encodeURIComponent(quem);
}

/**
 * Uma chamada à API de administração. `caminho` começa com "/admin/v1/…". Erro vira `ErroSistemas` com texto em
 * português, já sem a chave e sem o endereço do servidor. Sem redirecionamento: o cabeçalho com a chave não vai
 * parar em outro endereço.
 */
export async function sistemasChamar(
  cfg: ConfigSistemas,
  metodo: 'GET' | 'POST',
  caminho: string,
  o: { corpo?: unknown; query?: Record<string, string | number | undefined>; quem?: string; timeoutMs?: number } = {},
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== '') q.append(k, String(v));
  const url = `${cfg.api}${caminho}${q.size ? `?${q.toString()}` : ''}`;
  const headers: Record<string, string> = { 'x-admin-key': cfg.chave, Accept: 'application/json' };
  if (o.quem) headers['x-admin-quem'] = cabecalhoQuem(o.quem);
  if (metodo === 'POST') headers['Content-Type'] = 'application/json';
  let resp: Response;
  try {
    resp = await fetcher(url, {
      method: metodo,
      headers,
      body: metodo === 'POST' ? JSON.stringify(o.corpo ?? {}) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
  } catch {
    throw new ErroSistemas('não consegui falar com o servidor do sistema novo (sem resposta ou tempo esgotado): confira se ele está no ar e a URL base no painel de integrações', null);
  }
  const texto = await resp.text().catch(() => '');
  let dados: unknown = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }
  const erroDoServidor = typeof (dados as { erro?: unknown } | null)?.erro === 'string' ? limpar(String((dados as { erro: string }).erro), cfg).slice(0, 600) : null;
  // 401 = chave errada. 403 com mensagem do servidor é regra dele (ex.: "apagar não vale em fin_*") e vai como veio.
  if (resp.status === 401 || (resp.status === 403 && !erroDoServidor)) {
    throw new ErroSistemas('o servidor do sistema novo recusou a chave de administração: cadastre a chave certa no painel de integrações', resp.status);
  }
  if (!resp.ok) {
    if (erroDoServidor) throw new ErroSistemas(erroDoServidor, resp.status);
    if (resp.status === 404) throw new ErroSistemas('o servidor do sistema novo não tem essa rota (404): confira a URL base no painel de integrações e a versão do servidor', 404);
    throw new ErroSistemas(`o servidor do sistema novo respondeu com erro (HTTP ${resp.status})`, resp.status);
  }
  if (dados === null || typeof dados !== 'object') {
    throw new ErroSistemas(`o servidor do sistema novo respondeu algo que não é JSON (HTTP ${resp.status}): confira a URL base no painel de integrações`, resp.status);
  }
  return dados;
}

/** Prova a configuração: lê a lista de usuários. Devolve o rótulo para o painel (só contagem, nada pessoal). */
export async function testarChaveSistemas(texto: string, fetcher: Fetcher = fetch): Promise<string> {
  const cfg = lerConfigSistemas(texto);
  const r = (await sistemasChamar(cfg, 'GET', '/admin/v1/usuarios', {}, fetcher)) as { usuarios?: unknown[] };
  const n = Array.isArray(r.usuarios) ? r.usuarios.length : null;
  return `Sistema novo (RH/Caixa)${n !== null ? ` · ${n} usuários` : ''}${cfg.tela ? '' : ' · sem endereço da tela RH (convite ficará indisponível)'}`.slice(0, 250);
}
