// ============================================================================
// google-oauth.controller.ts — Endpoints OAuth 2.0 do Google Calendar.
//
// Fluxo:
//   1. Frontend abre  GET /api/units/:id/google-oauth/start  em nova aba
//   2. Backend redireciona pro Google consent screen
//   3. Google redireciona de volta pra GOOGLE_OAUTH_REDIRECT_URI
//      (que aponta pra GET /api/google-oauth/callback?code=...&state=<unitId>)
//   4. Backend troca code por tokens, salva na Unit, mostra HTML "Conectado"
// ============================================================================

import type { Request, Response } from 'express';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  isGoogleConfigured,
} from '../services/google-calendar.service.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export async function googleOAuthStartHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  if (!isGoogleConfigured()) {
    res.status(503).send(
      `<html><body style="font-family: sans-serif; padding: 40px; background: #0c0c12; color: #e4e4e7">
        <h1>⚠ Google OAuth não configurado</h1>
        <p>Defina <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> e <code>GOOGLE_OAUTH_REDIRECT_URI</code> nas variáveis de ambiente do backend.</p>
        <p>Setup: Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs.</p>
      </body></html>`,
    );
    return;
  }
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).send('Unit não encontrada');
    return;
  }
  const url = buildAuthUrl(unitId);
  res.redirect(url);
}

export async function googleOAuthCallbackHandler(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code ?? '');
  const unitId = String(req.query.state ?? '');
  const errorParam = req.query.error;

  if (errorParam) {
    res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px;background:#0c0c12;color:#fda4af">
      <h1>❌ Conexão cancelada</h1>
      <p>O Google retornou: <code>${String(errorParam)}</code></p>
      <p>Feche essa aba e tente conectar novamente pelo painel.</p>
    </body></html>`);
    return;
  }

  if (!code || !unitId) {
    res.status(400).send('Parâmetros inválidos (code/state ausentes)');
    return;
  }

  try {
    await exchangeCodeForTokens(code, unitId);
    res.status(200).send(
      `<html><body style="font-family: sans-serif; padding: 40px; background: #0c0c12; color: #a7f3d0; text-align: center">
        <h1>✅ Google Calendar conectado!</h1>
        <p>A IA agora consegue agendar consultas no seu calendário.</p>
        <p style="color:#71717a; margin-top:24px; font-size:13px">Pode fechar essa aba e voltar pro painel agente-dt.</p>
        <script>setTimeout(() => window.close(), 3000);</script>
      </body></html>`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, unitId }, 'google oauth callback failed');
    res.status(500).send(
      `<html><body style="font-family:sans-serif;padding:40px;background:#0c0c12;color:#fda4af">
        <h1>❌ Erro ao conectar</h1>
        <p>${msg}</p>
      </body></html>`,
    );
  }
}

// Endpoint pra desconectar — limpa os tokens da Unit.
export async function googleOAuthDisconnectHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  await prisma.unit.update({
    where: { id: unitId },
    data: {
      googleAccessToken: null,
      googleRefreshToken: null,
      googleTokenExpiresAt: null,
      googleAuthorizedEmail: null,
      googleAuthorizedAt: null,
      googleCalendarId: null,
    },
  });
  res.json({ ok: true });
}
