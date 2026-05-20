// ============================================================================
// auth.service.ts — login email+senha do painel.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Substitui o login Google. Senha é hasheada com bcrypt (12 rounds default,
// configurável). Não tem signup público — usuários são criados pelo super
// admin no UsersPanel ou via CLI `promote-admin`.
//
// `login(email, password)`:
//   - 401 se email não existe
//   - 401 se senha errada
//   - 401 se user.isActive === false
//   - 401 se user.passwordHash === null (criado sem senha — admin precisa
//     resetar antes do user conseguir entrar)
//   - Atualiza lastLoginAt em background.
//
// `setPassword(userId, plain)`:
//   - bcrypt.hash com rounds do env.
//   - Política mínima: 8 chars. Sem outras regras (sem maiúscula obrigatória
//     etc) — UX > teatro de segurança. bcrypt+rate-limit + senha que o admin
//     escolhe deliberadamente já cobre a ameaça realista.
//
// Erros em formato AuthError pra o controller traduzir.
// ============================================================================

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

// ---------------------------------------------------------------------------
// login — usado pelo POST /api/auth/login
// ---------------------------------------------------------------------------

export async function login(emailRaw: string, password: string): Promise<User> {
  const email = (emailRaw ?? '').trim().toLowerCase();
  if (!email || !password) throw new AuthError('invalid_credentials');

  const user = await prisma.user.findUnique({ where: { email } });

  // Sempre rodar bcrypt mesmo se o user não existir — equaliza tempo de
  // resposta, evita oráculo de enumeração de email.
  const hashToCompare = user?.passwordHash ?? '$2a$12$invalidsaltinvalidsaltinvali';
  const valid = await bcrypt.compare(password, hashToCompare);

  if (!user) throw new AuthError('invalid_credentials');
  if (!user.isActive) throw new AuthError('account_disabled');
  if (!user.passwordHash) throw new AuthError('no_password_set');
  if (!valid) throw new AuthError('invalid_credentials');

  // Update lastLoginAt em background — não bloqueia o login.
  void prisma.user
    .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    .catch((err) => logger.warn({ err }, 'lastLoginAt update falhou'));

  return user;
}

// ---------------------------------------------------------------------------
// hashPassword / setPassword
// ---------------------------------------------------------------------------

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
