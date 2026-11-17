/**
 * O Chatwoot de verdade (HTTP) para o kit: a API de PLATAFORMA (conta e usuário, token do Platform App) e a API da CONTA (token do usuário
 * conector da clínica). Formatos conforme developers.chatwoot.com — NÃO provados contra o Chatwoot real (o teste usa `chatwoot-falso.ts`).
 */
import { chamar, criarContextoChatwoot } from '../../mcp-remoto/chatwoot.js';
import { ErroDaPorta, type ContaPorta, type ContaSoLeitura, type PlataformaPorta } from './portas.js';

type Buscar = typeof fetch;

const mascara = (texto: string, segredos: string[]): string => segredos.filter(Boolean).reduce((t, s) => t.split(s).join('***'), texto);

/** Plataforma: `POST /platform/api/v1/accounts`, `…/users`, `…/accounts/{id}/account_users`. */
export function plataformaHttp(url: string, token: string, buscar: Buscar = fetch): PlataformaPorta {
  const base = url.replace(/\/+$/, '');
  async function pedir(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<{ status: number; dados: any }> {
    const r = await buscar(`${base}/platform/api/v1/${caminho}`, {
      method: metodo,
      headers: { api_access_token: token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(60_000),
    });
    const texto = await r.text();
    let dados: any = null;
    try {
      dados = texto ? JSON.parse(texto) : null;
    } catch {
      dados = texto;
    }
    return { status: r.status, dados };
  }
  const falha = (quando: string, r: { status: number; dados: any }): ErroDaPorta =>
    new ErroDaPorta(`Chatwoot (plataforma) ${r.status} ao ${quando}: ${mascara(JSON.stringify(r.dados?.message ?? r.dados?.error ?? r.dados ?? '').slice(0, 300), [token])}`, r.status);
  return {
    async contaExiste(id) {
      const r = await pedir('GET', `accounts/${id}`);
      if (r.status === 404) return false;
      if (r.status >= 400) throw falha(`ler a conta ${id}`, r);
      return true;
    },
    async criarConta(nome) {
      const r = await pedir('POST', 'accounts', { name: nome });
      if (r.status >= 400 || !Number.isInteger(r.dados?.id)) throw falha('criar a conta', r);
      return { id: Number(r.dados.id) };
    },
    async criarUsuario(u) {
      const r = await pedir('POST', 'users', { name: u.nome, email: u.email, password: u.senha, display_name: u.nome });
      const acesso = r.dados?.access_token;
      if (r.status >= 400 || !Number.isInteger(r.dados?.id) || typeof acesso !== 'string' || !acesso) throw falha('criar o usuário conector', r);
      return { id: Number(r.dados.id), tokenDeAcesso: acesso };
    },
    async vincular(contaId, usuarioId, papel) {
      const r = await pedir('POST', `accounts/${contaId}/account_users`, { user_id: usuarioId, role: papel });
      if (r.status >= 400) throw falha(`vincular o usuário ${usuarioId} à conta ${contaId}`, r);
    },
  };
}

/** Uma conta só para LER (a de referência): o objeto devolvido NÃO tem `post`. */
export function contaHttpSoLeitura(url: string, conta: number, token: string, buscar: Buscar = fetch): ContaSoLeitura {
  const c = contaHttp(url, conta, token, buscar);
  return { conta: c.conta, get: (caminho, query) => c.get(caminho, query) };
}

/** Uma conta: reaproveita `chamar` do conector (caminho preso à conta, token no cabeçalho, erro sem token). */
export function contaHttp(url: string, conta: number, token: string, buscar: Buscar = fetch): ContaPorta {
  const ctx = criarContextoChatwoot({ url: url.replace(/\/+$/, ''), conta, token }, { fetch: buscar });
  return {
    conta,
    get: (caminho, query) => chamar(ctx, 'GET', caminho, { query }),
    post: (caminho, corpo) => chamar(ctx, 'POST', caminho, { corpo }),
  };
}
