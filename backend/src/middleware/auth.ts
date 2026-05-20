// ============================================================================
// middleware/auth.ts — proteção das rotas do painel.
//
// Três níveis:
//   requireAuth        → existe cookie de sessão válido + user ativo no DB
//   requireSuperAdmin  → requireAuth + role === SUPER_ADMIN
//   requireUnitAccess  → requireAuth + (SUPER_ADMIN OU UNIT_ADMIN da unit alvo)
//
// O `requireAuth` faz fetch do User no DB a cada request — não confia só
// no JWT. Isso permite revogação imediata: super admin desativa um
// UNIT_ADMIN, ele perde acesso na próxima requisição mesmo com cookie
// ainda válido.
// ============================================================================

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { verifySession } from '../lib/auth.js';

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies?.[env.AUTH_COOKIE_NAME];
  if (!token || typeof token !== 'string') {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const payload = verifySession(token);
  if (!payload) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || !user.isActive) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  req.user = user;
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (req.user.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

// `requireUnitAccess` precisa do id da unit no req. Por padrão lê de
// `req.params.id` (rota /units/:id/...) ou `req.params.unitId`. Se nenhum,
// passa em branco e exige só auth — o caller deve validar de outro jeito.
export function requireUnitAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (req.user.role === 'SUPER_ADMIN') {
    next();
    return;
  }
  const targetUnitId = String(req.params.id ?? req.params.unitId ?? '');
  if (!targetUnitId) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (req.user.unitId !== targetUnitId) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
