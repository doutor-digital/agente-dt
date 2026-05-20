// ============================================================================
// users.service.ts — gestão de usuários do painel.
//
// CRUD usado pelo SUPER_ADMIN no painel: criar UNIT_ADMIN, promover, revogar,
// resetar senha. Não envia email — o super admin passa a senha pra pessoa
// por canal externo (WhatsApp/voz).
// ============================================================================

import type { User, UserRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from './auth.service.js';

export interface UserInputCreate {
  email: string;
  name?: string | null;
  role: UserRole;
  unitId?: string | null;
  /** Senha em texto plano. Será hasheada antes de gravar. */
  password: string;
}

export interface UserInputUpdate {
  name?: string | null;
  role?: UserRole;
  unitId?: string | null;
  isActive?: boolean;
  /** Reset de senha — opcional. Se ausente, senha não muda. */
  password?: string;
}

export async function listUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function createUser(input: UserInputCreate): Promise<User> {
  validateRoleConsistency(input.role, input.unitId ?? null);
  const passwordHash = await hashPassword(input.password);
  return prisma.user.create({
    data: {
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      role: input.role,
      unitId: input.role === 'UNIT_ADMIN' ? (input.unitId ?? null) : null,
      passwordHash,
      isActive: true,
    },
  });
}

export async function updateUser(id: string, input: UserInputUpdate): Promise<User> {
  const current = await prisma.user.findUnique({ where: { id } });
  if (!current) {
    throw new Prisma.PrismaClientKnownRequestError('User não encontrado', {
      code: 'P2025',
      clientVersion: '0',
    });
  }
  const finalRole = input.role ?? current.role;
  const finalUnitId = input.unitId !== undefined ? input.unitId : current.unitId;
  validateRoleConsistency(finalRole, finalUnitId);

  const passwordHash = input.password ? await hashPassword(input.password) : undefined;

  return prisma.user.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.unitId !== undefined && {
        unitId: finalRole === 'UNIT_ADMIN' ? input.unitId : null,
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(passwordHash !== undefined && { passwordHash }),
    },
  });
}

export async function deleteUser(id: string): Promise<void> {
  await prisma.user.delete({ where: { id } });
}

// SUPER_ADMIN nunca tem unitId. UNIT_ADMIN sempre tem.
function validateRoleConsistency(role: UserRole, unitId: string | null): void {
  if (role === 'UNIT_ADMIN' && !unitId) {
    throw new Error('UNIT_ADMIN exige unitId');
  }
}
