// ============================================================================
// users.controller.ts — CRUD de admins (super admin convida unit admins).
//
// Todas as rotas exigem SUPER_ADMIN (aplicado no router).
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createUser, deleteUser, listUsers, updateUser } from '../services/users.service.js';

const roleSchema = z.enum(['SUPER_ADMIN', 'UNIT_ADMIN']);

const createSchema = z
  .object({
    email: z.string().email(),
    name: z.string().max(120).nullable().optional(),
    role: roleSchema,
    unitId: z.string().cuid().nullable().optional(),
    password: z.string().min(8, 'Senha precisa ter no mínimo 8 caracteres'),
  })
  .refine((d) => d.role !== 'UNIT_ADMIN' || !!d.unitId, {
    message: 'UNIT_ADMIN exige unitId',
    path: ['unitId'],
  });

const updateSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  role: roleSchema.optional(),
  unitId: z.string().cuid().nullable().optional(),
  isActive: z.boolean().optional(),
  // Reset de senha — opcional.
  password: z.string().min(8, 'Senha precisa ter no mínimo 8 caracteres').optional(),
});

// Output: never returns email-only sensitive data. User schema é "público" por natureza.
function publicUser(u: Awaited<ReturnType<typeof listUsers>>[number]) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    role: u.role,
    unitId: u.unitId,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export async function listUsersHandler(_req: Request, res: Response): Promise<void> {
  const users = await listUsers();
  res.json({ users: users.map(publicUser) });
}

export async function createUserHandler(req: Request, res: Response): Promise<void> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  // Se UNIT_ADMIN, valida que a unit existe.
  if (parsed.data.role === 'UNIT_ADMIN' && parsed.data.unitId) {
    const unit = await prisma.unit.findUnique({ where: { id: parsed.data.unitId } });
    if (!unit) {
      res.status(400).json({ error: 'unit_not_found' });
      return;
    }
  }
  try {
    const user = await createUser(parsed.data);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'email_already_exists' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'createUser failed');
    res.status(500).json({ error: 'create_failed', message: msg });
  }
}

export async function updateUserHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  // Evita super admin se desativar acidentalmente (e ficar sem admin).
  if (parsed.data.isActive === false && req.user?.id === id) {
    res.status(400).json({ error: 'cannot_deactivate_self' });
    return;
  }
  try {
    const user = await updateUser(id, parsed.data);
    res.json({ user: publicUser(user) });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'updateUser failed');
    res.status(500).json({ error: 'update_failed', message: msg });
  }
}

export async function deleteUserHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  // Evita auto-delete (deixaria o painel sem admin se for o único SUPER_ADMIN).
  if (req.user?.id === id) {
    res.status(400).json({ error: 'cannot_delete_self' });
    return;
  }
  try {
    await deleteUser(id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      res.status(404).json({ error: 'user_not_found' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'delete_failed', message: msg });
  }
}
