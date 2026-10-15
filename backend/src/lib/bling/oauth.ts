/**
 * OAuth 2.0 da API v3 do Bling (ERP) — só o que é puro ou depende de `fetch` injetado, pra testar sem rede.
 *
 * Como o Bling funciona (developer.bling.com.br/aplicativos, conferido em 15/10/2026):
 * - Só "authorization code". O administrador do Bling abre o link de autorização, aprova, e o Bling manda
 *   o navegador para o link de redirecionamento CADASTRADO no aplicativo (o `redirect_uri` do pedido é
 *   ignorado) com `?code=…&state=…`. O código vale 1 MINUTO.
 * - O token sai de POST /oauth/token com o cliente em Basic (base64 de client_id:client_secret) — nunca no corpo.
 * - Access token ~6 h (`expires_in: 21600`), refresh token 30 dias. A renovação devolve um par novo.
 * - Limite da API: 3 requisições/s e 120 mil/dia por conta (ver `cliente.ts`).
 */

export const BLING_AUTORIZAR = 'https://www.bling.com.br/Api/v3/oauth/authorize';
export const BLING_TOKEN = 'https://www.bling.com.br/Api/v3/oauth/token';
export const BLING_API = 'https://api.bling.com.br/Api/v3';

/** O refresh token vale 30 dias a partir da emissão. */
export const VALIDADE_REFRESH_DIAS = 30;
/** O `state` do OAuth vale 10 minutos (o código do Bling vale 1, mas a pessoa pode demorar a logar). */
export const VALIDADE_ESTADO_MIN = 10;
/** Renova o access token quando faltar menos que isto. */
export const MARGEM_RENOVACAO_MIN = 30;

export interface TokensBling {
  accessToken: string;
  refreshToken: string;
  expiraEm: Date;
  escopos: string | null;
}

export class ErroBling extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** O refresh token não serve mais (vencido, revogado ou já usado): só uma nova autorização resolve. */
    readonly precisaReautorizar = false,
  ) {
    super(message);
    this.name = 'ErroBling';
  }
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function linkDeAutorizacao(clientId: string, estado: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, state: estado });
  return `${BLING_AUTORIZAR}?${q.toString()}`;
}

export function cabecalhoBasic(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

/** O `state` ainda vale? (gerado há menos de VALIDADE_ESTADO_MIN) */
export function estadoValido(geradoEm: Date | null | undefined, agora = new Date()): boolean {
  if (!geradoEm) return false;
  const idade = agora.getTime() - geradoEm.getTime();
  return idade >= 0 && idade <= VALIDADE_ESTADO_MIN * 60_000;
}

/** Hora de renovar? Sem data de vencimento conhecida, renova. */
export function precisaRenovar(expiraEm: Date | null | undefined, agora = new Date(), margemMin = MARGEM_RENOVACAO_MIN): boolean {
  if (!expiraEm) return true;
  return expiraEm.getTime() - agora.getTime() <= margemMin * 60_000;
}

/** Quando o refresh token atual vence (30 dias depois de emitido). */
export function refreshVenceEm(emitidoEm: Date): Date {
  return new Date(emitidoEm.getTime() + VALIDADE_REFRESH_DIAS * 86_400_000);
}

/** Texto curto do erro do Bling, sem repetir token nenhum (o corpo de erro não traz token, mas cortamos mesmo assim). */
function mensagemDoErro(corpo: unknown, status: number): string {
  const c = corpo as { error?: unknown; error_description?: unknown; message?: unknown } | null;
  const e = c?.error;
  if (e && typeof e === 'object') {
    const o = e as { type?: unknown; message?: unknown; description?: unknown };
    return [o.type, o.message, o.description].filter((x) => typeof x === 'string' && x).join(' — ').slice(0, 300) || `HTTP ${status}`;
  }
  const partes = [e, c?.error_description, c?.message].filter((x) => typeof x === 'string' && x) as string[];
  return partes.join(' — ').slice(0, 300) || `HTTP ${status}`;
}

/**
 * POST /oauth/token. `corpo` = { grant_type: 'authorization_code', code } ou { grant_type: 'refresh_token', refresh_token }.
 * Formulário (RFC 6749 §4.1.3); o cliente vai no Basic.
 */
export async function pedirTokens(
  app: { clientId: string; clientSecret: string },
  corpo: Record<string, string>,
  fetcher: Fetcher = fetch,
  agora = new Date(),
): Promise<TokensBling> {
  let resp: Response;
  try {
    resp = await fetcher(BLING_TOKEN, {
      method: 'POST',
      headers: {
        Authorization: cabecalhoBasic(app.clientId, app.clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(corpo).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ErroBling(`sem resposta do Bling: ${String(err).slice(0, 200)}`, null);
  }

  const texto = await resp.text();
  let json: unknown = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    /* corpo não-JSON: cai no erro abaixo com o status */
  }

  if (!resp.ok) {
    const msg = mensagemDoErro(json, resp.status);
    // invalid_grant = código vencido/usado ou refresh token inválido: não adianta tentar de novo.
    const reautorizar = resp.status === 400 && /invalid_grant|invalid_token|expired|revog/i.test(msg);
    throw new ErroBling(`Bling recusou o pedido de token (${resp.status}): ${msg}`, resp.status, reautorizar);
  }

  const j = (json ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof j.access_token !== 'string' || !j.access_token || typeof j.refresh_token !== 'string' || !j.refresh_token) {
    throw new ErroBling('resposta de token do Bling sem access_token/refresh_token', resp.status);
  }
  const segundos = Number(j.expires_in);
  const validade = Number.isFinite(segundos) && segundos > 0 ? segundos : 21_600;
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiraEm: new Date(agora.getTime() + validade * 1000),
    escopos: typeof j.scope === 'string' ? j.scope : null,
  };
}
