// ============================================================================
// scripts/promote-admin.ts — cria/atualiza um usuário com role específica.
//
// Uso:
//   tsx src/scripts/promote-admin.ts --email=foo@x.com --role=SUPER_ADMIN
//   tsx src/scripts/promote-admin.ts --email=foo@x.com --role=UNIT_ADMIN --unit-slug=clinica-x
//
// Útil pra promover/criar admins sem precisar de painel (ex: emergência).
// ============================================================================

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { createUser, updateUser } from '../services/users.service.js';

interface Args {
  email?: string;
  role?: 'SUPER_ADMIN' | 'UNIT_ADMIN';
  unitSlug?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'email') out.email = value;
    else if (key === 'role') {
      if (value === 'SUPER_ADMIN' || value === 'UNIT_ADMIN') out.role = value;
    } else if (key === 'unit-slug') out.unitSlug = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email || !args.role) {
    console.error('Uso: --email=<email> --role=SUPER_ADMIN|UNIT_ADMIN [--unit-slug=<slug>]');
    process.exit(2);
  }
  if (args.role === 'UNIT_ADMIN' && !args.unitSlug) {
    console.error('UNIT_ADMIN exige --unit-slug=<slug>');
    process.exit(2);
  }

  try {
    let unitId: string | null = null;
    if (args.unitSlug) {
      const unit = await prisma.unit.findUnique({ where: { slug: args.unitSlug } });
      if (!unit) {
        console.error(`❌ Unit "${args.unitSlug}" não encontrada.`);
        process.exit(3);
      }
      unitId = unit.id;
    }

    const email = args.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      const updated = await updateUser(existing.id, {
        role: args.role,
        unitId,
        isActive: true,
      });
      console.log(`✅ Atualizado: ${updated.email} → ${updated.role}${unitId ? ` (unit=${args.unitSlug})` : ''}`);
    } else {
      const user = await createUser({ email, role: args.role, unitId });
      console.log(`✅ Criado: ${user.email} → ${user.role}${unitId ? ` (unit=${args.unitSlug})` : ''}`);
      console.log(`   Peça pra fazer login no painel com Google usando esse email.`);
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      console.error('❌ Email duplicado.');
      process.exit(3);
    }
    console.error('❌ Falha:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
