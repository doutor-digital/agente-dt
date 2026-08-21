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
