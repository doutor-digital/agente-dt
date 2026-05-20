// ============================================================================
// auth.controller.ts — Endpoints de login/logout/me + callback OAuth.
//
// FLUXO
//   1. GET /api/auth/google/start    → seta cookie `auth_state` (CSRF), redir
//   2. GET /api/auth/google/callback → valida state, troca code, cria sessão
//   3. POST /api/auth/logout         → limpa cookie
//   4. GET  /api/auth/me             → eco do user atual (ou 401)
//
// O cookie `auth_state` é httpOnly e expira em 10min. Sem ele no callback,
// rejeita (proteção CSRF contra ataque de login-CSRF onde o atacante faz a
// vítima logar na conta DELE). State value: base64url 32 bytes.
// ============================================================================

import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import {
  AuthError,
  buildAuthUrl,
  exchangeCodeForGoogleUser,
  isAuthConfigured,
  loginOrProvisionUser,
} from '../services/auth.service.js';
import {
  signSession,
  sessionCookieOptions,
  SESSION_COOKIE_MAX_AGE_MS,
} from '../lib/auth.js';

const STATE_COOKIE = 'auth_state';
const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

function frontendOrigin(): string {
  return env.FRONTEND_ORIGIN[0] ?? 'http://localhost:5173';
}

// ---------------------------------------------------------------------------
// GET /api/auth/google/start
// ---------------------------------------------------------------------------

export function googleStartHandler(req: Request, res: Response): void {
  if (!isAuthConfigured()) {
    res.status(503).json({
      error: 'oauth_not_configured',
      hint: 'Setar GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_AUTH_REDIRECT_URI no .env',
    });
    return;
  }
  const state = crypto.randomBytes(24).toString('base64url');
  res.cookie(STATE_COOKIE, state, sessionCookieOptions(STATE_COOKIE_MAX_AGE_MS));
  res.redirect(buildAuthUrl(state));
}

// ---------------------------------------------------------------------------
// GET /api/auth/google/callback
// ---------------------------------------------------------------------------

export async function googleCallbackHandler(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code ?? '');
  const state = String(req.query.state ?? '');
  const expectedState = req.cookies?.[STATE_COOKIE];

  // Limpa o state cookie de imediato — uso único.
  res.clearCookie(STATE_COOKIE, sessionCookieOptions());

  if (!code) {
    return redirectWithError(res, 'missing_code');
  }
  if (!state || !expectedState || state !== expectedState) {
    return redirectWithError(res, 'state_mismatch');
  }

  try {
    const googleUser = await exchangeCodeForGoogleUser(code);
    const user = await loginOrProvisionUser(googleUser);
    const jwt = signSession({
      userId: user.id,
      role: user.role,
      unitId: user.unitId,
    });
    res.cookie(env.AUTH_COOKIE_NAME, jwt, sessionCookieOptions(SESSION_COOKIE_MAX_AGE_MS));
    res.redirect(frontendOrigin());
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn({ code: err.code }, 'auth callback rejeitou login');
      return redirectWithError(res, err.code);
    }
    logger.error({ err }, 'auth callback erro inesperado');
    return redirectWithError(res, 'internal_error');
  }
}

function redirectWithError(res: Response, code: string): void {
  const url = `${frontendOrigin()}/?auth_error=${encodeURIComponent(code)}`;
  res.redirect(url);
}

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

export function logoutHandler(_req: Request, res: Response): void {
  res.clearCookie(env.AUTH_COOKIE_NAME, sessionCookieOptions());
  res.status(204).end();
}

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

export function meHandler(req: Request, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const { id, email, name, picture, role, unitId } = req.user;
  res.json({ user: { id, email, name, picture, role, unitId } });
}
