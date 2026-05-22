// ============================================================================
// whatsapp-cost-sync.service.ts — Persiste analytics da Meta no Postgres.
//
// LÓGICA DE ENGENHARIA
// --------------------
// `meta-analytics.service` consulta a Graph API on-demand (com cache de 60s).
// Aqui transformamos o snapshot remoto num snapshot LOCAL persistido — duas
// tabelas:
//
//   whatsapp_cost_daily       ← pricing_analytics  (volume + cost)
//   whatsapp_template_daily   ← template_analytics (sent/delivered/read/clicked + cost)
//
// Estratégia:
//   1. Pegamos uma JANELA ROLANTE (default 7 dias) — não só o dia anterior,
//      porque a Meta pode REVISAR valores em até ~48h após o evento. Dia
//      antigo pode mudar; o upsert reflete a versão mais recente.
//   2. Para cada linha da Graph API, derivamos a CHAVE LÓGICA do
//      `@@unique` (unitId+date+categoria+tipo+país+phone+tier) e fazemos
//      `prisma.upsert`. Idempotente.
//   3. NUNCA jogamos exception — sync é fire-and-forget no cron.
//
// Logs ricos: cada Unit/janela registra { ok, rows, totalUsd, error? }.
// ============================================================================

import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  fetchPricingAnalytics,
  fetchTemplateAnalytics,
  fetchMessageTemplates,
  type MessageTemplate,
} from './meta-analytics.service.js';

/** Range em dias rolante padrão. A Meta revisa valores em até ~48h. */
const DEFAULT_LOOKBACK_DAYS = 7;

export interface SyncUnitResult {
  unitId: string;
  unitSlug: string;
  ok: boolean;
  pricingRowsUpserted: number;
  templateRowsUpserted: number;
  totalCostUsd: number;
  totalVolume: number;
  errors: string[];
}

/** Trunca um Date para 00:00:00 UTC do mesmo dia. */
function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Resolve a janela (start, end) em segundos unix, alinhada a 00:00 UTC. */
function resolveWindow(lookbackDays: number): { startSec: number; endSec: number } {
  const now = new Date();
  // end exclusivo: amanhã 00:00 UTC pra incluir o dia corrente inteiro.
  const endDate = toUtcMidnight(now);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const startDate = toUtcMidnight(now);
  startDate.setUTCDate(startDate.getUTCDate() - (lookbackDays - 1));
  return {
    startSec: Math.floor(startDate.getTime() / 1000),
    endSec: Math.floor(endDate.getTime() / 1000),
  };
}

/** Sync de UMA Unit. */
export async function syncUnitWhatsappCosts(
  unit: {
    id: string;
    slug: string;
    metaWabaId: string | null;
    metaAccessToken: string | null;
  },
  options: { lookbackDays?: number } = {},
): Promise<SyncUnitResult> {
  const result: SyncUnitResult = {
    unitId: unit.id,
    unitSlug: unit.slug,
    ok: true,
    pricingRowsUpserted: 0,
    templateRowsUpserted: 0,
    totalCostUsd: 0,
    totalVolume: 0,
    errors: [],
  };

  if (!unit.metaWabaId || !unit.metaAccessToken) {
    result.ok = false;
    result.errors.push('unit sem metaWabaId ou metaAccessToken');
    return result;
  }

  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const { startSec, endSec } = resolveWindow(lookbackDays);

  // ---- pricing_analytics -------------------------------------------------
  const pricing = await fetchPricingAnalytics(unit, { start: startSec, end: endSec });
  if (!pricing.ok || !pricing.data) {
    result.errors.push(`pricing_analytics: ${pricing.error ?? 'erro desconhecido'}`);
  } else {
    for (const row of pricing.data.rows) {
      // start é o início do bucket DAILY — usamos a parte de data (UTC).
      const date = toUtcMidnight(new Date(row.start * 1000));
      try {
        const key = {
          unitId_date_pricingCategory_pricingType_country_phoneNumber_tier: {
            unitId: unit.id,
            date,
            pricingCategory: row.pricingCategory,
            pricingType: row.pricingType,
            country: row.country,
            phoneNumber: row.phoneNumber,
            tier: row.tier,
          },
        } satisfies Prisma.WhatsappCostDailyWhereUniqueInput;
        await prisma.whatsappCostDaily.upsert({
          where: key,
          create: {
            unitId: unit.id,
            date,
            pricingCategory: row.pricingCategory,
            pricingType: row.pricingType,
            country: row.country,
            phoneNumber: row.phoneNumber,
            tier: row.tier,
            volume: row.volume,
            costUsd: row.costUsd,
            currency: row.currency,
            syncedAt: new Date(),
          },
          update: {
            volume: row.volume,
            costUsd: row.costUsd,
            currency: row.currency,
            syncedAt: new Date(),
          },
        });
        result.pricingRowsUpserted += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, unitId: unit.id, row }, 'upsert whatsappCostDaily falhou');
        result.errors.push(`upsert cost: ${msg}`);
      }
    }
    result.totalCostUsd = pricing.data.totalCostUsd;
    result.totalVolume = pricing.data.totalVolume;
  }

  // ---- template_analytics (com metadata de templates) -------------------
  // A Meta EXIGE `template_ids` como obrigatório no endpoint. Buscamos a
  // lista de templates da WABA e passamos os IDs em batches (limite ~50 por
  // chamada — a Meta corta com erro se passar muitos).
  const templates = await fetchMessageTemplates(unit);
  const templateMeta = new Map<string, MessageTemplate>();
  if (templates.ok && templates.data) {
    for (const t of templates.data) templateMeta.set(t.id, t);
  } else {
    // Não é fatal — só não denormaliza name/language. Logamos pra UI ver.
    result.errors.push(`message_templates: ${templates.error ?? 'erro desconhecido'}`);
  }

  const allTemplateIds = [...templateMeta.keys()];
  if (allTemplateIds.length === 0) {
    // WABA sem templates cadastrados → não tem o que pedir.
    // Não é erro; só pula silenciosamente.
  } else {
    const CHUNK_SIZE = 25;
    for (let i = 0; i < allTemplateIds.length; i += CHUNK_SIZE) {
      const batch = allTemplateIds.slice(i, i + CHUNK_SIZE);
      const templateAnalytics = await fetchTemplateAnalytics(
        unit,
        { start: startSec, end: endSec, templateIds: batch },
        templateMeta,
      );
      if (!templateAnalytics.ok || !templateAnalytics.data) {
        result.errors.push(
          `template_analytics (batch ${i / CHUNK_SIZE + 1}): ${templateAnalytics.error ?? 'erro desconhecido'}`,
        );
        continue;
      }
      for (const row of templateAnalytics.data.rows) {
        const date = toUtcMidnight(new Date(row.start * 1000));
        try {
          const key = {
            unitId_date_templateId_language: {
              unitId: unit.id,
              date,
              templateId: row.templateId,
              language: row.language,
            },
          } satisfies Prisma.WhatsappTemplateDailyWhereUniqueInput;
          await prisma.whatsappTemplateDaily.upsert({
            where: key,
            create: {
              unitId: unit.id,
              date,
              templateId: row.templateId,
              templateName: row.templateName,
              language: row.language,
              sent: row.sent,
              delivered: row.delivered,
              read: row.read,
              clicked: row.clicked,
              costUsd: row.costUsd,
              currency: row.currency,
              syncedAt: new Date(),
            },
            update: {
              templateName: row.templateName,
              sent: row.sent,
              delivered: row.delivered,
              read: row.read,
              clicked: row.clicked,
              costUsd: row.costUsd,
              currency: row.currency,
              syncedAt: new Date(),
            },
          });
          result.templateRowsUpserted += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err, unitId: unit.id, row }, 'upsert whatsappTemplateDaily falhou');
          result.errors.push(`upsert template: ${msg}`);
        }
      }
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

/** Sync de TODAS as Units ativas que têm credenciais. */
export async function syncAllUnitsWhatsappCosts(
  options: { lookbackDays?: number } = {},
): Promise<SyncUnitResult[]> {
  const units = await prisma.unit.findMany({
    where: {
      isActive: true,
      metaWabaId: { not: null },
      metaAccessToken: { not: null },
    },
    select: { id: true, slug: true, metaWabaId: true, metaAccessToken: true },
  });

  if (units.length === 0) {
    logger.info('whatsapp-cost-sync: nenhuma Unit com metaWabaId+metaAccessToken');
    return [];
  }

  const results: SyncUnitResult[] = [];
  for (const unit of units) {
    const r = await syncUnitWhatsappCosts(unit, options);
    results.push(r);
    logger.info(
      {
        unit: r.unitSlug,
        ok: r.ok,
        pricingRows: r.pricingRowsUpserted,
        templateRows: r.templateRowsUpserted,
        totalCostUsd: r.totalCostUsd.toFixed(4),
        errors: r.errors,
      },
      'whatsapp-cost-sync: unit processada',
    );
  }
  return results;
}
