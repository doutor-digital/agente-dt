import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message?: string) {
    super(message ?? code);
  }
}

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'account_disabled'
  | 'password_too_short'
  | 'no_password_set';

export async function login(emailRaw: string, password: string): Promise<User> {
  const email = (emailRaw ?? '').trim().toLowerCase();
  if (!email || !password) throw new AuthError('invalid_credentials');

  const user = await prisma.user.findUnique({ where: { email } });

  const hashToCompare = user?.passwordHash ?? '$2a$12$invalidsaltinvalidsaltinvali';
  const valid = await bcrypt.compare(password, hashToCompare);

  if (!user) throw new AuthError('invalid_credentials');
  if (!user.isActive) throw new AuthError('account_disabled');
  if (!user.passwordHash) throw new AuthError('no_password_set');
  if (!valid) throw new AuthError('invalid_credentials');

  void prisma.user
    .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    .catch((err) => logger.warn({ err }, 'lastLoginAt update falhou'));

  return user;
}

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('password_too_short');
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function setPassword(userId: string, plain: string): Promise<void> {
  const passwordHash = await hashPassword(plain);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}
