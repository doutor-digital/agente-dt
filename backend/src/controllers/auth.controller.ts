import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { AuthError, login } from '../services/auth.service.js';
import {
  signSession,
  sessionCookieOptions,
  SESSION_COOKIE_MAX_AGE_MS,
} from '../lib/auth.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }
  try {
    const user = await login(parsed.data.email, parsed.data.password);
    const jwt = signSession({
      userId: user.id,
      role: user.role,
      unitId: user.unitId,
    });
    res.cookie(env.AUTH_COOKIE_NAME, jwt, sessionCookieOptions(SESSION_COOKIE_MAX_AGE_MS));
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        role: user.role,
        unitId: user.unitId,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      const expose: AuthError['code'][] = ['account_disabled', 'no_password_set'];
      const code = expose.includes(err.code) ? err.code : 'invalid_credentials';
      res.status(401).json({ error: code });
      return;
    }
    logger.error({ err }, 'login erro inesperado');
    res.status(500).json({ error: 'internal_error' });
  }
}

export function logoutHandler(_req: Request, res: Response): void {
  res.clearCookie(env.AUTH_COOKIE_NAME, sessionCookieOptions());
  res.status(204).end();
}

export function meHandler(req: Request, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const { id, email, name, picture, role, unitId } = req.user;
  res.json({ user: { id, email, name, picture, role, unitId } });
}
