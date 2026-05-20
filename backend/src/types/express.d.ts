// ============================================================================
// express.d.ts — Augment do Request com `user` populado pelo requireAuth.
// ============================================================================

import type { User } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export {};
