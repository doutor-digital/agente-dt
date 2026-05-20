// ============================================================================
// auth.service.ts — Login via Google + provisionamento de User.
//
// LÓGICA DE ENGENHARIA
// --------------------
// OAuth 2.0 do Google sem SDK (mesmo padrão de google-calendar.service.ts):
//  1. /api/auth/google/start  → URL do consentimento
//  2. callback recebe code    → troca por access_token + id_token
//  3. id_token decodificado pra extrair email já verificado
//  4. loginOrProvisionUser    → upsert atômico do User
//
// BOOTSTRAP "FIRST-LOGIN-WINS"
// ---------------------------
// Enquanto a tabela `users` está vazia, o primeiro email que logar vira
// SUPER_ADMIN. Se BOOTSTRAP_ALLOWED_EMAIL estiver setado, só esse email
// passa. Tudo isso DENTRO de uma transação Serializable pra impedir que
// dois requests concorrentes criem dois super admins.
//
// Depois que tem >=1 user, novos logins precisam que o email exista
// previamente (criado por um super admin pelo painel). Erro `not_invited`.
// ============================================================================

import axios from 'axios';
import type { User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Erros tipados — o controller traduz pra HTTP code + querystring de erro.
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message?: string) {
    super(message ?? code);
  }
}

export type AuthErrorCode =
  | 'oauth_not_configured'
  | 'invalid_code'
  | 'email_not_verified'
  | 'not_invited'
  | 'account_disabled';

// ---------------------------------------------------------------------------
// 1. URL de consentimento.
// ---------------------------------------------------------------------------

const SCOPES = ['openid', 'email', 'profile'];

export function isAuthConfigured(): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_AUTH_REDIRECT_URI);
}

export function buildAuthUrl(state: string): string {
  if (!isAuthConfigured()) throw new AuthError('oauth_not_configured');
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_AUTH_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'online',          // login não precisa de refresh_token
    prompt: 'select_account',       // sempre mostrar seletor (UX comum em painéis)
    state,                          // CSRF — validado no callback
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// 2. Trocar code por tokens e extrair email do id_token.
// ---------------------------------------------------------------------------

interface GoogleUser {
  email: string;
  name: string | null;
  picture: string | null;
  emailVerified: boolean;
}

export async function exchangeCodeForGoogleUser(code: string): Promise<GoogleUser> {
  if (!isAuthConfigured()) throw new AuthError('oauth_not_configured');

  let tokens: { id_token?: string; access_token: string };
  try {
    const { data } = await axios.post<{
      access_token: string;
      id_token?: string;
      expires_in: number;
    }>(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: env.GOOGLE_AUTH_REDIRECT_URI!,
        grant_type: 'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    tokens = data;
  } catch (err) {
    logger.warn({ err }, 'google token exchange falhou');
    throw new AuthError('invalid_code');
  }

  // Preferimos o id_token (JWT assinado pelo Google) ao /userinfo: é mais
  // rápido (decode local) e a assinatura garante o email verificado.
  // Como o token chegou direto do endpoint /token via HTTPS, podemos
  // confiar no payload sem verificar a assinatura novamente.
  if (tokens.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split('.')[1], 'base64').toString(),
      ) as {
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      if (!payload.email) throw new Error('id_token sem email');
      return {
        email: payload.email.toLowerCase(),
        name: payload.name ?? null,
        picture: payload.picture ?? null,
        emailVerified: payload.email_verified === true,
      };
    } catch (err) {
      logger.warn({ err }, 'id_token decode falhou; caindo no /userinfo');
    }
  }

  // Fallback: chama /userinfo se id_token não veio ou falhou ao decodificar.
  const { data: info } = await axios.get<{
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  }>('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  return {
    email: info.email.toLowerCase(),
    name: info.name ?? null,
    picture: info.picture ?? null,
    emailVerified: info.email_verified === true,
  };
}

// ---------------------------------------------------------------------------
// 3. Login/provisionamento atômico.
// ---------------------------------------------------------------------------

export async function loginOrProvisionUser(g: GoogleUser): Promise<User> {
  if (!g.emailVerified) throw new AuthError('email_not_verified');

  // Caminho rápido: user já existe.
  const existing = await prisma.user.findUnique({ where: { email: g.email } });
  if (existing) {
    if (!existing.isActive) throw new AuthError('account_disabled');
    // Atualiza metadados em background — não bloqueia o login se falhar.
    void prisma.user
      .update({
        where: { id: existing.id },
        data: {
          lastLoginAt: new Date(),
          name: g.name ?? existing.name,
          picture: g.picture ?? existing.picture,
        },
      })
      .catch((err) => logger.warn({ err }, 'falha atualizando lastLoginAt'));
    return existing;
  }

  // Caminho lento: user não existe — pode ser o bootstrap.
  return prisma.$transaction(
    async (tx) => {
      const count = await tx.user.count();
      if (count > 0) {
        // Banco já tem admins; novos logins precisam ser convidados.
        throw new AuthError('not_invited');
      }
      if (env.BOOTSTRAP_ALLOWED_EMAIL && g.email !== env.BOOTSTRAP_ALLOWED_EMAIL.toLowerCase()) {
        throw new AuthError('not_invited');
      }
      const created = await tx.user.create({
        data: {
          email: g.email,
          name: g.name,
          picture: g.picture,
          role: 'SUPER_ADMIN',
          unitId: null,
          isActive: true,
          lastLoginAt: new Date(),
        },
      });
      logger.warn(
        { email: created.email, userId: created.id },
        '[BOOTSTRAP] first super admin created',
      );
      return created;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
