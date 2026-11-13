/**
 * Tradutor Chatwoot → Kapso (13/11/2026). O canal nativo "WhatsApp Cloud" do Chatwoot fala com a Graph API da Meta usando
 * `Authorization: Bearer <api_key>` no endereço de `WHATSAPP_CLOUD_BASE_URL`. O Kapso imita a Graph API em
 * `https://api.kapso.ai/meta/whatsapp/<versão>/...`, mas só aceita a chave em `X-API-Key` (Bearer volta 401, medido).
 *
 * Com `WHATSAPP_CLOUD_BASE_URL=https://agente-vps.doutordigitalconsultoria.com/api/public/kapso-meta` no Chatwoot, este
 * tradutor recebe a chamada, troca o cabeçalho e repassa para o Kapso. A chave que o Chatwoot guarda na caixa É a chave do
 * Kapso: aqui ela só muda de cabeçalho, nunca é guardada nem logada.
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

/** Troca, no JSON de resposta, toda URL do Kapso por uma que passa por este tradutor. */
export function reescreverUrls(valor: unknown, base: string): unknown {
  if (typeof valor === 'string') return valor.startsWith(`${KAPSO_HOST}/`) ? `${base}/_kapso/${valor.slice(KAPSO_HOST.length + 1)}` : valor;
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
  const chave = chaveDoBearer(req.get('authorization'));
  if (!chave) {
    res.status(401).json({ error: 'sem chave' });
    return;
  }
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const metodo = req.method.toUpperCase();
  const comCorpo = !['GET', 'HEAD', 'DELETE'].includes(metodo) && req.body !== undefined;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LIMITE_MS);
  try {
    const r = await (deps.fetch ?? fetch)(`${destino}${qs}`, {
      method: metodo,
      headers: { 'X-API-Key': chave, ...(comCorpo ? { 'Content-Type': 'application/json' } : {}) },
      body: comCorpo ? JSON.stringify(req.body) : undefined,
      signal: ctrl.signal,
    });
    const tipo = r.headers.get('content-type') ?? '';
    res.status(r.status);
    if (tipo.includes('application/json')) {
      const corpo = await r.json().catch(() => null);
      res.json(reescreverUrls(corpo, baseDoTradutor()));
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
