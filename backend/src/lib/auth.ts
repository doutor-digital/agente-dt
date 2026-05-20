// ============================================================================
// auth.ts — JWT de sessão do painel.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cookie httpOnly carrega um JWT HS256 assinado com SESSION_JWT_SECRET.
// O payload tem o mínimo (`userId`, `role`, `unitId`) — basta pra fazer
// authz nos middlewares sem ir no DB em todo request. Mas o middleware
// `requireAuth` AINDA carrega o User do banco a cada request, pra
// pegar mudanças de role (revogação) em tempo real. Esse JWT é só o
// "ticket" — autoridade final é o banco.
//
// Trade-off: o JWT sozinho não suporta revogação imediata (até expirar).
// Por isso o re-fetch no DB. Em troca, ganhamos sessão stateless (sem
// store de sessão) e cookie pequeno.
// ============================================================================

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

// Retorna `null` em qualquer erro (expirado, assinatura inválida, malformado).
// O caller decide o que fazer (em geral: 401).
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

// Cookie config compartilhado entre set e clear, pra garantir que o `clear`
// bata exatamente o mesmo cookie que o `set`. Diferente do que parece, o
// navegador NÃO apaga um cookie se domain/path divergirem do original.
//
// SameSite em produção é 'none' porque o front (Vercel) e o back (Railway)
// vivem em domínios diferentes — XHR cross-site só carrega o cookie se for
// SameSite=None + Secure. Em dev (mesmo localhost), 'lax' é mais seguro.
export function sessionCookieOptions(maxAge?: number) {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    secure: isProd, // obrigatório quando sameSite='none'
    path: '/',
    domain: env.AUTH_COOKIE_DOMAIN,
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

export const SESSION_COOKIE_MAX_AGE_MS = TTL_SECONDS * 1000;
