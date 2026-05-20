// ============================================================================
// users.service.ts — gestão de usuários do painel.
//
// Diferente de auth.service.ts (que cuida do login), esse módulo é o CRUD
// usado pelo SUPER_ADMIN no painel: convidar UNIT_ADMIN, promover, revogar.
// Não envia email — o convite é "implícito" (basta o email logar com Google).
// ============================================================================

import type { User, UserRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export interface UserInputCreate {
  email: string;
  name?: string | null;
  role: UserRole;
  unitId?: string | null;
}

export interface UserInputUpdate {
  name?: string | null;
  role?: UserRole;
  unitId?: string | null;
  isActive?: boolean;
}

export async function listUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function createUser(input: UserInputCreate): Promise<User> {
  validateRoleConsistency(input.role, input.unitId ?? null);
  return prisma.user.create({
    data: {
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      role: input.role,
      unitId: input.role === 'UNIT_ADMIN' ? (input.unitId ?? null) : null,
      isActive: true,
    },
  });
}

export async function updateUser(id: string, input: UserInputUpdate): Promise<User> {
  // Pra validar a consistência role/unitId, precisamos saber o estado final.
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

  return prisma.user.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.unitId !== undefined && {
        unitId: finalRole === 'UNIT_ADMIN' ? input.unitId : null,
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
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
