// ============================================================================
// scripts/create-unit.ts — cria uma Unit pelo terminal.
//
// Uso:
//   pnpm --filter agente-dt-backend exec tsx src/scripts/create-unit.ts \
//     --slug=clinica-sorrir --name="Clínica Sorrir" \
//     [--admin-email=admin@clinica.com]
//
// `--admin-email` opcional cria/promove o user como UNIT_ADMIN da unit recém-
// criada. Útil pra entregar acesso pra cliente final num único comando.
// ============================================================================

import { Prisma } from '@prisma/client';
import { createUnit } from '../services/units.service.js';
import { createUser, updateUser } from '../services/users.service.js';
import { prisma } from '../lib/prisma.js';

interface Args {
  slug?: string;
  name?: string;
  adminEmail?: string;
  adminPassword?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'slug') out.slug = value;
    else if (key === 'name') out.name = value;
    else if (key === 'admin-email') out.adminEmail = value;
    else if (key === 'admin-password') out.adminPassword = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.slug || !args.name) {
    console.error(
      'Uso: --slug=<kebab-case> --name="<nome>" [--admin-email=<email> --admin-password=<senha>]',
    );
    process.exit(2);
  }
  if (args.adminEmail && !args.adminPassword) {
    console.error('--admin-email exige --admin-password (mín. 8 chars).');
    process.exit(2);
  }
  if (args.adminPassword && args.adminPassword.length < 8) {
    console.error('--admin-password precisa ter no mínimo 8 caracteres.');
    process.exit(2);
  }

  const slugRegex = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
  if (!slugRegex.test(args.slug)) {
    console.error('slug inválido. Use kebab-case (a-z, 0-9, -), 3-50 chars.');
    process.exit(2);
  }

  try {
    const unit = await createUnit({ slug: args.slug, name: args.name });
    console.log(`✅ Unit criada: id=${unit.id} slug=${unit.slug} name=${unit.name}`);

    if (args.adminEmail && args.adminPassword) {
      const email = args.adminEmail.toLowerCase();
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        const updated = await updateUser(existing.id, {
          role: 'UNIT_ADMIN',
          unitId: unit.id,
          isActive: true,
          password: args.adminPassword,
        });
        console.log(
          `✅ Admin promovido: ${updated.email} → UNIT_ADMIN de ${unit.slug} (senha redefinida)`,
        );
      } else {
        const user = await createUser({
          email,
          role: 'UNIT_ADMIN',
          unitId: unit.id,
          password: args.adminPassword,
        });
        console.log(
          `✅ Admin convidado: ${user.email} (UNIT_ADMIN de ${unit.slug}). ` +
            `Repasse a senha pelo canal seguro.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      console.error(`❌ Slug "${args.slug}" já existe.`);
      process.exit(3);
    }
    console.error('❌ Falha ao criar unit:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
