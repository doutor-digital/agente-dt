import jwt from 'jsonwebtoken';
import { env } from './env.js';

export interface SessionPayload {
  userId: string;
  role: 'SUPER_ADMIN' | 'UNIT_ADMIN';
  unitId: string | null;
}

const TTL_SECONDS = env.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60;

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, env.SESSION_JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: TTL_SECONDS,
    subject: payload.userId,
  });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, env.SESSION_JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (typeof decoded !== 'object' || decoded === null) return null;
    const d = decoded as Record<string, unknown>;
    if (typeof d.userId !== 'string') return null;
    if (d.role !== 'SUPER_ADMIN' && d.role !== 'UNIT_ADMIN') return null;
    if (d.unitId !== null && typeof d.unitId !== 'string') return null;
    return {
      userId: d.userId,
      role: d.role,
      unitId: d.unitId as string | null,
    };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAge?: number) {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    secure: isProd,
    path: '/',
    domain: env.AUTH_COOKIE_DOMAIN,
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

export const SESSION_COOKIE_MAX_AGE_MS = TTL_SECONDS * 1000;
