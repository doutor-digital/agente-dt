import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  fetchPricingAnalytics,
  fetchTemplateAnalytics,
  fetchMessageTemplates,
  formatMetaError,
  type MessageTemplate,
} from './meta-analytics.service.js';

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

function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function resolveWindow(lookbackDays: number): { startSec: number; endSec: number } {
  const now = new Date();
  const endDate = toUtcMidnight(now);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const startDate = toUtcMidnight(now);
  startDate.setUTCDate(startDate.getUTCDate() - (lookbackDays - 1));
  return {
    startSec: Math.floor(startDate.getTime() / 1000),
    endSec: Math.floor(endDate.getTime() / 1000),
  };
}

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

  const pricing = await fetchPricingAnalytics(unit, { start: startSec, end: endSec });
  if (!pricing.ok || !pricing.data) {
    result.errors.push(`pricing_analytics: ${formatMetaError(pricing)}`);
  } else {
    for (const row of pricing.data.rows) {
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

  const templates = await fetchMessageTemplates(unit);
  const templateMeta = new Map<string, MessageTemplate>();
  if (templates.ok && templates.data) {
    for (const t of templates.data) templateMeta.set(t.id, t);
  } else {
    result.errors.push(`message_templates: ${formatMetaError(templates)}`);
  }

  const allTemplateIds = [...templateMeta.values()]
    .filter((t) => !t.status || t.status === 'APPROVED')
    .map((t) => t.id);
  if (allTemplateIds.length === 0) {
  } else {
    const runBatch = async (ids: string[]): Promise<{ ok: boolean; errorMsg?: string }> => {
      const r = await fetchTemplateAnalytics(
        unit,
        { start: startSec, end: endSec, templateIds: ids },
        templateMeta,
      );
      if (!r.ok || !r.data) {
        return { ok: false, errorMsg: formatMetaError(r) };
      }
      for (const row of r.data.rows) {
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
      return { ok: true };
    };

    const CHUNK_SIZE = 10;
    for (let i = 0; i < allTemplateIds.length; i += CHUNK_SIZE) {
      const batch = allTemplateIds.slice(i, i + CHUNK_SIZE);
      const batchN = i / CHUNK_SIZE + 1;
      const r = await runBatch(batch);
      if (r.ok) continue;

      const failed: string[] = [];
      for (const id of batch) {
        const single = await runBatch([id]);
        if (!single.ok) {
          const name = templateMeta.get(id)?.name ?? id;
          failed.push(`${name} (${id})`);
        }
      }
      if (failed.length === 0) {
        continue;
      }
      result.errors.push(
        `template_analytics (batch ${batchN}): ${r.errorMsg}. Templates problemáticos: ${failed.join(', ')}`,
      );
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

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
