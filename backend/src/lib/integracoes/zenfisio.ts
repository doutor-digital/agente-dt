/**
 * Leitura da API v1.1 do ZenFisio (gestão de clínica de fisioterapia: agenda, pacientes, pacotes, financeiro). SÓ GET depois do login:
 * a API pública não tem rota de escrita documentada, e este cliente não teria como usar uma.
 *
 * Autenticação (coleção "ZenFisio API V1.1" no Postman): OAuth2 com grant `password` em POST {base}/oauth/token, levando
 * client_id + client_secret (pedidos ao suporte do ZenFisio) E e-mail + senha de um usuário do sistema. Não existe
 * client_credentials: sem usuário não há token. O token vale 24 h (`expires_in` 86400); aqui ele fica em memória até 5 min antes
 * de vencer e, num 401 no meio do caminho, é descartado e pedido de novo uma vez.
 *
 * A "chave" guardada no painel é UMA linha de JSON:
 *   {"clientId":"105","clientSecret":"...","email":"...","senha":"...","entityId":42739}
 * `entityId` é a unidade dentro da conta do ZenFisio (GET /units); com ele, toda leitura vai em /entity/{entityId}/...
 *
 * Limite: 60 requisições por minuto (X-RateLimit-Limit). A janela daqui usa 55/min e respeita o Retry-After num 429.
 * Erros nunca carregam o segredo, a senha nem o token.
 */
import { JanelaDeRitmo } from './convenia.js';
import { dormir } from '../../franquia-mcp/ritmo.js';

export const ZENFISIO_URL = (process.env.ZENFISIO_URL || 'https://app.zenfisio.com').replace(/\/+$/, '');
const AGENTE = 'DoutorDigital-Conector/1.0';
const FORMATO = 'cole UMA linha de JSON: {"clientId":"<id>","clientSecret":"<secret>","email":"<login do ZenFisio>","senha":"<senha>","entityId":<id da unidade>}';

export class ErroZenfisio extends Error {
  constructor(msg: string, readonly status: number | null) {
    super(msg);
  }
}

export interface ConfigZenfisio {
  clientId: string;
  clientSecret: string;
  email: string;
  senha: string;
  /** unidade dentro da conta do ZenFisio; ausente = a conta tem uma unidade só e ela é descoberta no teste */
  entityId?: number;
}

/** Lê e valida a "chave" (JSON) do painel. A mensagem de erro nunca repete o que foi colado. */
export function lerConfigZenfisio(texto: string): ConfigZenfisio {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new Error(`o conteúdo não é um JSON válido: ${FORMATO}`);
  }
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new Error(`o conteúdo não é um objeto JSON: ${FORMATO}`);
  const o = bruto as Record<string, unknown>;
  const texto_ = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const clientId = texto_(o.clientId);
  const clientSecret = texto_(o.clientSecret);
  const email = texto_(o.email);
  const senha = typeof o.senha === 'string' ? o.senha : ''; // a senha NÃO leva trim: espaço pode fazer parte dela
  if (!clientId) throw new Error('"clientId" ausente: é o Client ID que o suporte do ZenFisio mandou');
  if (clientSecret.length < 10) throw new Error('"clientSecret" ausente ou curto demais: confira se copiou inteiro');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('"email" ausente ou inválido: é o e-mail de login do usuário do ZenFisio');
  if (!senha) throw new Error('"senha" ausente: é a senha de login desse usuário');
  const cfg: ConfigZenfisio = { clientId, clientSecret, email, senha };
  if (o.entityId !== undefined && o.entityId !== null && o.entityId !== '') {
    const n = Number(o.entityId);
    if (!Number.isInteger(n) || n <= 0) throw new Error('"entityId" tem que ser o número da unidade no ZenFisio (veja GET /units)');
    cfg.entityId = n;
  }
  return cfg;
}

type Fetcher = typeof fetch;
const janelas = new Map<string, JanelaDeRitmo>();
const tokens = new Map<string, { token: string; expira: number }>();

/** Esquece os tokens guardados (testes, ou a chave trocou no painel). */
export function esquecerTokensZenfisio(): void {
  tokens.clear();
}

function janelaDe(contaId: string): JanelaDeRitmo {
  let j = janelas.get(contaId);
  if (!j) janelas.set(contaId, (j = new JanelaDeRitmo(55, 60_000)));
  return j;
}

/** Retry-After em segundos, com teto de 60 s. */
function esperaPedida(resp: Response, tentativa: number): number {
  const s = Number(resp.headers.get('retry-after'));
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 60_000);
  return Math.min(2000 * (tentativa + 1), 10_000);
}

/** Tira da mensagem tudo que não pode sair: segredo, senha e e-mail de login. */
function limpar(texto: string, cfg: ConfigZenfisio): string {
  let t = texto;
  for (const s of [cfg.clientSecret, cfg.senha, cfg.email]) if (s && s.length >= 3) t = t.split(s).join('[omitido]');
  return t.slice(0, 300);
}

/** A mensagem que a API põe em `message`/`error_description`, sem nada do pedido. */
function mensagemDoErro(texto: string, cfg: ConfigZenfisio): string {
  try {
    const j = JSON.parse(texto) as { message?: unknown; error_description?: unknown; error?: unknown };
    const m = [j.error_description, j.message, j.error].find((x) => typeof x === 'string' && x);
    if (typeof m === 'string') return limpar(m, cfg);
  } catch {
    // não é JSON: cai no texto cru
  }
  return limpar(texto, cfg);
}

/** Login: troca as quatro credenciais por um Bearer. Guarda em memória até 5 min antes de vencer. */
export async function tokenZenfisio(contaId: string, cfg: ConfigZenfisio, fetcher: Fetcher = fetch, agora: () => number = Date.now): Promise<string> {
  const guardado = tokens.get(contaId);
  if (guardado && guardado.expira > agora()) return guardado.token;
  await janelaDe(contaId).vez();
  let resp: Response;
  try {
    resp = await fetcher(`${ZENFISIO_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': AGENTE },
      body: JSON.stringify({ grant_type: 'password', client_id: cfg.clientId, client_secret: cfg.clientSecret, username: cfg.email, password: cfg.senha }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ErroZenfisio(`sem resposta do ZenFisio no login: ${limpar(String(err), cfg)}`, null);
  }
  const texto = await resp.text();
  if (!resp.ok) {
    let codigo = '';
    try {
      codigo = String((JSON.parse(texto) as { error?: unknown }).error ?? '');
    } catch {
      // segue com o status
    }
    if (codigo === 'invalid_client') {
      throw new ErroZenfisio('o ZenFisio recusou o Client ID/Client Secret (invalid_client): confira com o suporte do ZenFisio', resp.status);
    }
    if (codigo === 'invalid_credentials' || codigo === 'invalid_grant') {
      throw new ErroZenfisio(
        'o ZenFisio aceitou o Client ID/Secret mas recusou o e-mail ou a senha (invalid_credentials): confira o login do usuário ' +
          '(espaço sobrando, conta que entra só pelo Google, ou credencial do suporte vinculada a outro usuário)',
        resp.status,
      );
    }
    throw new ErroZenfisio(`login no ZenFisio falhou (${resp.status}): ${mensagemDoErro(texto, cfg)}`, resp.status);
  }
  let corpo: { access_token?: unknown; expires_in?: unknown };
  try {
    corpo = JSON.parse(texto) as typeof corpo;
  } catch {
    throw new ErroZenfisio('login no ZenFisio devolveu algo que não é JSON', resp.status);
  }
  if (typeof corpo.access_token !== 'string' || !corpo.access_token) throw new ErroZenfisio('login no ZenFisio sem access_token na resposta', resp.status);
  const validade = Number(corpo.expires_in);
  const segundos = Number.isFinite(validade) && validade > 0 ? validade : 3600;
  tokens.set(contaId, { token: corpo.access_token, expira: agora() + Math.max(segundos - 300, 60) * 1000 });
  return corpo.access_token;
}

/**
 * GET autenticado no ZenFisio. `contaId` separa o token e a janela de ritmo de cada conta; `caminho` começa com "/" e é relativo
 * a /api/v1. Repete em 429 (respeitando o Retry-After), 5xx e falha de rede; num 401 refaz o login uma vez.
 */
export async function zenfisioGet<T = unknown>(
  contaId: string,
  cfg: ConfigZenfisio,
  caminho: string,
  query: Record<string, string | number | boolean | undefined> = {},
  fetcher: Fetcher = fetch,
  agora: () => number = Date.now,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.append(k, String(v));
  const url = `${ZENFISIO_URL}/api/v1${caminho}${q.size ? `?${q.toString()}` : ''}`;
  let relogou = false;
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const token = await tokenZenfisio(contaId, cfg, fetcher, agora);
    await janelaDe(contaId).vez();
    let resp: Response;
    try {
      resp = await fetcher(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': AGENTE },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (tentativa < 3) { await dormir(1000 * (tentativa + 1)); continue; }
      throw new ErroZenfisio(`sem resposta do ZenFisio em ${caminho}: ${limpar(String(err), cfg)}`, null);
    }
    if (resp.status === 401 && !relogou) {
      relogou = true;
      tokens.delete(contaId);
      tentativa--; // o relogin não gasta tentativa
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && tentativa < 3) {
      await dormir(resp.status === 429 ? esperaPedida(resp, tentativa) : 1500 * (tentativa + 1));
      continue;
    }
    const texto = await resp.text();
    if (resp.status === 401) throw new ErroZenfisio('o ZenFisio recusou o token mesmo depois de um novo login (401)', 401);
    if (resp.status === 403) throw new ErroZenfisio(`o usuário do ZenFisio não tem acesso a ${caminho} (403)`, 403);
    if (resp.status === 422) throw new ErroZenfisio(`o ZenFisio recusou os parâmetros de ${caminho}: ${mensagemDoErro(texto, cfg)}`, 422);
    if (!resp.ok) throw new ErroZenfisio(`ZenFisio ${resp.status} em ${caminho}: ${mensagemDoErro(texto, cfg)}`, resp.status);
    if (!texto) return null as T;
    try {
      return JSON.parse(texto) as T;
    } catch {
      throw new ErroZenfisio(`ZenFisio ${resp.status} em ${caminho}: resposta que não é JSON (${limpar(texto.slice(0, 120), cfg)})`, resp.status);
    }
  }
  throw new ErroZenfisio(`ZenFisio não respondeu em ${caminho} depois de 4 tentativas`, 429);
}

export interface UnidadeZenfisio {
  id: number;
  name?: string | null;
  is_main_entity?: number | null;
}

/**
 * Prova a chave: faz o login, lê as unidades da conta e confere o `entityId`. Devolve o rótulo para o painel (nome da unidade e
 * o id); CNPJ, telefone e e-mail da unidade não saem.
 */
export async function testarChaveZenfisio(texto: string, fetcher: Fetcher = fetch): Promise<string> {
  const cfg = lerConfigZenfisio(texto);
  const contaTeste = `teste:${cfg.clientId}`;
  tokens.delete(contaTeste);
  try {
    const unidades = await zenfisioGet<UnidadeZenfisio[]>(contaTeste, cfg, '/units', {}, fetcher);
    const lista = Array.isArray(unidades) ? unidades : [];
    if (!lista.length) throw new ErroZenfisio('o login funcionou mas a conta não tem nenhuma unidade (GET /units vazio)', null);
    const ids = lista.map((u) => `${u.id} (${u.name ?? 'sem nome'})`).join(', ');
    let alvo: UnidadeZenfisio | undefined;
    if (cfg.entityId !== undefined) {
      alvo = lista.find((u) => Number(u.id) === cfg.entityId);
      if (!alvo) throw new ErroZenfisio(`entityId ${cfg.entityId} não é uma unidade desta conta. Unidades: ${ids}`, null);
    } else if (lista.length === 1) {
      alvo = lista[0];
    } else {
      throw new ErroZenfisio(`a conta tem ${lista.length} unidades: ponha "entityId" no JSON. Unidades: ${ids}`, null);
    }
    return `ZenFisio · ${alvo!.name ?? 'unidade'} (entityId ${alvo!.id})`.slice(0, 250);
  } finally {
    tokens.delete(contaTeste);
  }
}

/** O `entityId` da chave; sem ele (conta de uma unidade só), lê de /units. */
export async function entityIdDaConta(contaId: string, cfg: ConfigZenfisio, fetcher: Fetcher = fetch): Promise<number> {
  if (cfg.entityId !== undefined) return cfg.entityId;
  const unidades = await zenfisioGet<UnidadeZenfisio[]>(contaId, cfg, '/units', {}, fetcher);
  const lista = Array.isArray(unidades) ? unidades : [];
  if (lista.length !== 1) throw new ErroZenfisio(`a conta do ZenFisio tem ${lista.length} unidades: ponha "entityId" na chave do painel`, null);
  return Number(lista[0]!.id);
}
