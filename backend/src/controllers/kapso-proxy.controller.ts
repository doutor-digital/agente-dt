/**
 * Tradutor Chatwoot → Kapso (13/11/2026). O canal nativo "WhatsApp Cloud" do Chatwoot fala com a Graph API da Meta usando
 * `Authorization: Bearer <api_key>` no endereço de `WHATSAPP_CLOUD_BASE_URL`. O Kapso imita a Graph API em
 * `https://api.kapso.ai/meta/whatsapp/<versão>/...`, mas só aceita a chave em `X-API-Key` (Bearer volta 401, medido).
 *
 * Com `WHATSAPP_CLOUD_BASE_URL=https://agente-vps.doutordigitalconsultoria.com/api/public/kapso-meta` no Chatwoot, este
 * tradutor recebe a chamada, troca o cabeçalho e repassa para o Kapso. A chave que o Chatwoot guarda na caixa É a chave do
 * Kapso: aqui ela só muda de cabeçalho, nunca é guardada nem logada.
 *
 * A validação da caixa no Chatwoot manda a chave na URL (`?access_token=`), não no cabeçalho: vale também, e ela sai da URL
 * antes de ir ao Kapso (o log do servidor mascara `access_token`).
 *
 * Mídia: a Graph devolve a URL do arquivo e o Chatwoot baixa essa URL com o mesmo Bearer. Se a URL for do próprio Kapso,
 * ela é reescrita para passar por aqui também (`/_kapso/<caminho>`), senão o download falharia com 401.
 *
 * Só destino fixo (api.kapso.ai): o caminho é conferido e nunca vira outro host.
 */
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';

export const KAPSO_HOST = 'https://api.kapso.ai';
export const KAPSO_META = `${KAPSO_HOST}/meta/whatsapp`;
export const PREFIXO_ROTA = '/api/public/kapso-meta';
const CAMINHO_GRAPH = /^v\d{1,2}\.\d{1,2}\/[A-Za-z0-9_\-./]+$/;
const CAMINHO_KAPSO = /^meta\/[A-Za-z0-9_\-./]+$/;
const LIMITE_MS = 30_000;
/** GET da Graph que devolve a URL de uma mídia: `vNN.N/<id da mídia>` (só dígitos). */
const CAMINHO_MIDIA = /^v\d{1,2}\.\d{1,2}\/\d{5,25}$/;
/** O link de download que o próprio Kapso assina (`?token=`, vale 4 min): baixa sem a chave da Meta. */
export const DOWNLOAD_KAPSO = `${KAPSO_HOST}/meta/whatsapp/media_download`;

/**
 * Os números (phone_number_id do Kapso) que passam por este tradutor. O Chatwoot pede a mídia SEM o número
 * (`GET /v13.0/<id>`) e o Kapso responde 404 «WhatsApp configuration not found» sem ele (medido 13/11/2026): por isso
 * todo áudio, foto e documento chegava VAZIO no Chatwoot. Tenta cada número até um não dar 404. Padrão: Parauapebas.
 */
export function numerosDoKapso(env: NodeJS.ProcessEnv = process.env): string[] {
  const l = String(env.KAPSO_PHONE_NUMBER_IDS ?? '')
    .split(/[\s,]+/)
    .filter((x) => /^\d{5,25}$/.test(x));
  return l.length ? l : ['1212928641906230'];
}

/**
 * A resposta da URL de mídia traz `url` (da Meta: lookaside.fbsbx.com, que só abre com o token da Meta — o Chatwoot manda a
 * chave do Kapso e leva 401) e `download_url` (do Kapso, autenticado no próprio link). O Chatwoot baixa `url`: entrega o do Kapso.
 */
export function comCopiaDoKapso(corpo: unknown): unknown {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return corpo;
  const d = (corpo as Record<string, unknown>).download_url;
  return typeof d === 'string' && d.startsWith(`${DOWNLOAD_KAPSO}?`) ? { ...(corpo as Record<string, unknown>), url: d } : corpo;
}

/** Destino no Kapso para o caminho recebido, ou null se o caminho não é aceito. */
export function destinoNoKapso(caminho: string): string | null {
  const c = String(caminho ?? '').replace(/^\/+/, '');
  if (c.split('/').some((p) => p === '..' || p === '.')) return null;
  if (c.startsWith('_kapso/')) {
    const resto = c.slice('_kapso/'.length);
    return CAMINHO_KAPSO.test(resto) ? `${KAPSO_HOST}/${resto}` : null;
  }
  return CAMINHO_GRAPH.test(c) ? `${KAPSO_META}/${c}` : null;
}

/** Chave do Bearer, ou null. */
export function chaveDoBearer(auth: string | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._\-]{20,200})$/.exec(String(auth ?? '').trim());
  return m ? m[1]! : null;
}

/** A query sem `access_token` (a chave não segue na URL para o Kapso). Devolve '' ou '?…'. */
export function querySemChave(urlOriginal: string): { query: string; chave: string | null } {
  const i = urlOriginal.indexOf('?');
  if (i < 0) return { query: '', chave: null };
  const p = new URLSearchParams(urlOriginal.slice(i + 1));
  const chave = p.get('access_token');
  p.delete('access_token');
  const q = p.toString();
  return { query: q ? `?${q}` : '', chave: chave && /^[A-Za-z0-9._\-]{20,200}$/.test(chave) ? chave : null };
}

/**
 * Troca, no JSON de resposta, toda URL do Kapso por uma que passa por este tradutor — menos o link de download assinado
 * (`media_download?token=`): ele já baixa sozinho, sem chave, e não precisa dar a volta pelo servidor.
 */
export function reescreverUrls(valor: unknown, base: string): unknown {
  if (typeof valor === 'string') return valor.startsWith(`${KAPSO_HOST}/`) && !valor.startsWith(`${DOWNLOAD_KAPSO}?`) ? `${base}/_kapso/${valor.slice(KAPSO_HOST.length + 1)}` : valor;
  if (Array.isArray(valor)) return valor.map((v) => reescreverUrls(v, base));
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, reescreverUrls(v, base)]));
  return valor;
}

export function baseDoTradutor(): string {
  let origem = 'https://agente-vps.doutordigitalconsultoria.com';
  try {
    if (process.env.MCP_URL_PUBLICA) origem = new URL(process.env.MCP_URL_PUBLICA).origin;
  } catch {
    /* fica o padrão */
  }
  return `${origem}${PREFIXO_ROTA}`;
}

export async function kapsoProxyHandler(req: Request, res: Response, deps: { fetch?: typeof fetch } = {}): Promise<void> {
  const caminho = String((req.params as Record<string, unknown>)[0] ?? (req.params as Record<string, unknown>).caminho ?? '');
  const destino = destinoNoKapso(Array.isArray(caminho) ? caminho.join('/') : caminho);
  if (!destino) {
    res.status(400).json({ error: 'caminho não aceito' });
    return;
  }
  const { query: qs, chave: chaveNaUrl } = querySemChave(req.originalUrl);
  const chave = chaveDoBearer(req.get('authorization')) ?? chaveNaUrl;
  if (!chave) {
    res.status(401).json({ error: 'sem chave' });
    return;
  }
  const metodo = req.method.toUpperCase();
  const comCorpo = !['GET', 'HEAD', 'DELETE'].includes(metodo) && req.body !== undefined;
  const caminhoLimpo = (Array.isArray(caminho) ? caminho.join('/') : caminho).replace(/^\/+/, '');
  // URL de mídia sem o número: o Kapso exige `phone_number_id` (sem ele, 404) — acrescenta, tentando cada número
  const ehMidia = metodo === 'GET' && CAMINHO_MIDIA.test(caminhoLimpo) && !/[?&]phone_number_id=/.test(qs);
  const urls = ehMidia ? numerosDoKapso().map((n) => `${destino}${qs ? `${qs}&` : '?'}phone_number_id=${n}`) : [`${destino}${qs}`];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LIMITE_MS);
  try {
    let r: globalThis.Response | undefined;
    for (const url of urls) {
      r = await (deps.fetch ?? fetch)(url, {
        method: metodo,
        headers: { 'X-API-Key': chave, ...(comCorpo ? { 'Content-Type': 'application/json' } : {}) },
        body: comCorpo ? JSON.stringify(req.body) : undefined,
        signal: ctrl.signal,
      });
      if (r.status !== 404) break;
    }
    if (!r) throw new Error('sem resposta');
    const tipo = r.headers.get('content-type') ?? '';
    res.status(r.status);
    if (tipo.includes('application/json')) {
      const corpo = await r.json().catch(() => null);
      res.json(reescreverUrls(ehMidia ? comCopiaDoKapso(corpo) : corpo, baseDoTradutor()));
      return;
    }
    // mídia e o resto: repassa os bytes como vieram
    if (tipo) res.type(tipo);
    const tam = r.headers.get('content-length');
    if (tam) res.set('Content-Length', tam);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    logger.warn({ err: String(err), metodo, destino: destino.replace(/\/\d{6,}/g, '/…') }, 'kapso-proxy: falhou ao falar com o Kapso');
    if (!res.headersSent) res.status(502).json({ error: 'Kapso não respondeu' });
  } finally {
    clearTimeout(t);
  }
}
