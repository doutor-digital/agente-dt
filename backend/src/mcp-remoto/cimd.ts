/**
 * Client ID Metadata Document (CIMD): em vez de se registrar, o cliente usa como `client_id` a URL
 * de um JSON que ele mesmo publica (redirect_uris, nome). É a opção que o claude.ai recomenda
 * ("Use Claude's published identity"). O SDK não traz isso; fica aqui.
 *
 * Buscar uma URL que veio de fora é convite a SSRF, então: só https, só hosts confiáveis,
 * sem seguir redirect, 5 s e 64 KB no máximo. E o documento tem que dizer que é ele mesmo
 * (`client_id` igual à URL), senão qualquer JSON viraria cliente.
 */
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const TTL_MS = 60 * 60_000;
const MAX_BYTES = 64 * 1024;

export class BuscadorCimd {
  private cache = new Map<string, { cliente: OAuthClientInformationFull; expira: number }>();

  constructor(
    private hostsConfiaveis: string[],
    private buscarUrl: typeof fetch = fetch,
    private agora: () => number = Date.now,
  ) {}

  private confiavel(url: URL): boolean {
    return url.protocol === 'https:' && this.hostsConfiaveis.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  }

  async buscar(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const guardado = this.cache.get(clientId);
    if (guardado && guardado.expira > this.agora()) return guardado.cliente;

    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return undefined;
    }
    if (!this.confiavel(url) || url.hash || url.username || url.password) return undefined;

    try {
      const r = await this.buscarUrl(url, { redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } });
      if (!r.ok) return undefined;
      const texto = await r.text();
      if (texto.length > MAX_BYTES) return undefined;
      const doc = JSON.parse(texto) as Record<string, unknown>;
      if (doc.client_id !== clientId) return undefined;
      const retornos = doc.redirect_uris;
      if (!Array.isArray(retornos) || !retornos.length || !retornos.every((x) => typeof x === 'string')) return undefined;
      const cliente: OAuthClientInformationFull = {
        client_id: clientId,
        redirect_uris: retornos as string[],
        client_name: typeof doc.client_name === 'string' ? doc.client_name : undefined,
        client_uri: typeof doc.client_uri === 'string' ? doc.client_uri : undefined,
        // documento público não carrega segredo: cliente público, autentica só com PKCE
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      };
      this.cache.set(clientId, { cliente, expira: this.agora() + TTL_MS });
      return cliente;
    } catch {
      return undefined;
    }
  }
}
