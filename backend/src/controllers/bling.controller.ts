/**
 * Conexão de uma unidade com o Bling (ERP) — HM Tecnologia, 15/10/2026.
 *
 * - GET /api/bling/callback (PÚBLICO, fica acima do requireAuth): o Bling devolve o navegador do
 *   administrador para cá com `code` e `state`; trocamos pelo token e mostramos "conectado".
 * - As demais são do painel, só SUPER_ADMIN: gravar o aplicativo, gerar o link de autorização,
 *   ver a situação e testar a conexão (lê o nome da empresa no Bling).
 *
 * Nenhuma resposta e nenhum log carrega token ou Client Secret.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { concluirAutorizacao, iniciarAutorizacao, salvarAppDoBling, statusDoBling } from '../lib/bling/conexao.js';
import { blingGet } from '../lib/bling/cliente.js';
import { ErroBling } from '../lib/bling/oauth.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function pagina(ok: boolean, titulo: string, texto: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title>
<style>
body{margin:0;background:#0B0B11;color:#F5F5F7;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.5;padding:40px 16px}
main{max-width:520px;margin:0 auto;background:#13131B;border:1px solid #2A2A36;border-radius:16px;padding:24px}
.sub{color:#8A8C97;font-size:14px;margin:0 0 8px}h1{font-size:22px;margin:0 0 12px}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:8px;background:${ok ? '#04D361' : '#F75A68'}}
</style></head><body><main>
<p class="sub">Doutor Digital · Bling</p>
<h1><span class="dot"></span>${esc(titulo)}</h1>
<p>${esc(texto)}</p>
</main></body></html>`;
}

/** GET /api/bling/callback?code=…&state=… — o retorno da autorização. Público. */
export async function blingCallbackHandler(req: Request, res: Response): Promise<void> {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const erro = typeof req.query.error === 'string' ? req.query.error : '';
  res.set('Cache-Control', 'no-store');
  if (erro) {
    res.status(400).type('html').send(pagina(false, 'Autorização não concluída', `O Bling respondeu: ${erro.slice(0, 120)}. Nada foi gravado.`));
    return;
  }
  try {
    const unidade = await concluirAutorizacao(state, code);
    res.type('html').send(pagina(true, 'Bling conectado', `A unidade ${unidade} está conectada ao Bling. Pode fechar esta página.`));
  } catch (err) {
    const msg = err instanceof ErroBling ? err.message : 'erro inesperado';
    logger.warn({ err: String(err) }, 'bling: retorno da autorização falhou');
    res.status(400).type('html').send(pagina(false, 'Não deu para conectar', `${msg}.`));
  }
}

const AppSchema = z.object({ clientId: z.string().min(10).max(200), clientSecret: z.string().min(10).max(300) });

function responderErro(res: Response, err: unknown): void {
  if (err instanceof ErroBling) {
    res.status(err.status && err.status >= 400 && err.status < 500 ? 409 : 400).json({ error: err.message, reautorizar: err.precisaReautorizar });
    return;
  }
  logger.warn({ err: String(err) }, 'bling: erro no painel');
  res.status(500).json({ error: 'erro inesperado' });
}

/** PUT /api/bling/:slug/app { clientId, clientSecret } — grava o aplicativo do Bling da unidade. */
export async function blingAppHandler(req: Request, res: Response): Promise<void> {
  const p = AppSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'clientId e clientSecret obrigatórios' }); return; }
  try {
    await salvarAppDoBling(String(req.params.slug), p.data.clientId, p.data.clientSecret);
    res.json({ ok: true });
  } catch (err) { responderErro(res, err); }
}

/** POST /api/bling/:slug/autorizar — link que o administrador do Bling abre (vale 10 min). */
export async function blingAutorizarHandler(req: Request, res: Response): Promise<void> {
  try {
    res.json(await iniciarAutorizacao(String(req.params.slug)));
  } catch (err) { responderErro(res, err); }
}

/** GET /api/bling/:slug/status — situação da conexão, sem segredo nenhum. */
export async function blingStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    res.json(await statusDoBling(String(req.params.slug)));
  } catch (err) { responderErro(res, err); }
}

/** GET /api/bling/:slug/teste — prova que a conexão funciona: lê os dados básicos da empresa no Bling. */
export async function blingTesteHandler(req: Request, res: Response): Promise<void> {
  try {
    const u = await prisma.unit.findUnique({ where: { slug: String(req.params.slug) }, select: { id: true } });
    if (!u) { res.status(404).json({ error: 'unidade não existe' }); return; }
    const r = await blingGet<{ data?: { nome?: string; fantasia?: string; cnpj?: string } }>(u.id, '/empresas/me/dados-basicos');
    res.json({ ok: true, empresa: r?.data?.fantasia || r?.data?.nome || null });
  } catch (err) { responderErro(res, err); }
}
