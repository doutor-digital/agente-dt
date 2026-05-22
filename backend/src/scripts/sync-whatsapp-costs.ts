// ============================================================================
// sync-whatsapp-costs.ts — Script CLI standalone.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Roda o sync de pricing_analytics + template_analytics da Meta Graph API
// pra todas as Units que têm metaWabaId + metaAccessToken configurados.
//
// USO
// ---
//   pnpm tsx src/scripts/sync-whatsapp-costs.ts [--days=7] [--unit=<slug>]
//
// FLAGS
//   --days=N      janela rolante em dias (default 7)
//   --unit=<slug> processar somente uma unit
//
// Quando rodado sem argumentos, processa TODAS as Units ativas elegíveis.
// É o mesmo código que o scheduler in-process do server.ts chama, mas
// permite trigger manual via cron externo (k8s CronJob, GitHub Actions, etc).
// ============================================================================

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  syncUnitWhatsappCosts,
  syncAllUnitsWhatsappCosts,
} from '../services/whatsapp-cost-sync.service.js';

interface CliArgs {
  days: number;
  unitSlug?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { days: 7 };
  for (const arg of argv) {
    if (arg.startsWith('--days=')) {
      const n = Number(arg.slice('--days='.length));
      if (Number.isFinite(n) && n > 0 && n <= 90) out.days = n;
    } else if (arg.startsWith('--unit=')) {
      out.unitSlug = arg.slice('--unit='.length).trim();
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.unitSlug) {
    const unit = await prisma.unit.findUnique({
      where: { slug: args.unitSlug },
      select: { id: true, slug: true, metaWabaId: true, metaAccessToken: true, isActive: true },
    });
    if (!unit) {
      logger.error({ slug: args.unitSlug }, 'Unit não encontrada');
      process.exit(1);
    }
    const result = await syncUnitWhatsappCosts(unit, { lookbackDays: args.days });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const results = await syncAllUnitsWhatsappCosts({ lookbackDays: args.days });
  const summary = {
    units: results.length,
    okCount: results.filter((r) => r.ok).length,
    pricingRowsTotal: results.reduce((s, r) => s + r.pricingRowsUpserted, 0),
    templateRowsTotal: results.reduce((s, r) => s + r.templateRowsUpserted, 0),
    totalCostUsd: results.reduce((s, r) => s + r.totalCostUsd, 0),
  };
  console.log(JSON.stringify({ summary, results }, null, 2));
  process.exit(summary.okCount === results.length ? 0 : 1);
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'sync-whatsapp-costs falhou');
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
