// ============================================================================
// prisma.ts — Singleton do Prisma Client.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Em dev, o hot-reload (tsx watch) recria módulos. Sem o singleton via
// globalThis, abriríamos uma nova conexão TCP ao Postgres a cada reload,
// estourando o `max_connections` em ~30 segundos de desenvolvimento.
// Em produção o módulo só carrega uma vez, então o `if` é inócuo.
// ============================================================================

import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

export const prisma =
  globalThis.__prisma__ ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV === 'development') {
  globalThis.__prisma__ = prisma;
}
