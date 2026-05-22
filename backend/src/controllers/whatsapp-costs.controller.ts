// ============================================================================
// whatsapp-costs.controller.ts — Endpoints REST do custo WhatsApp (Meta).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Dados vêm da tabela `whatsapp_cost_daily` e `whatsapp_template_daily`,
// populadas pelo sync diário (scheduler in-process + script CLI). Aqui
// só lemos + agregamos.
//
// 3 handlers:
//   GET  /api/units/:id/whatsapp-costs?from&to     → totais + breakdown + timeline
//   GET  /api/units/:id/whatsapp-templates?from&to → ranking de templates
//   POST /api/units/:id/whatsapp-costs/sync        → trigger manual do sync
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { syncUnitWhatsappCosts } from '../services/whatsapp-cost-sync.service.js';

const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const syncBodySchema = z.object({
  lookbackDays: z.number().int().min(1).max(90).optional(),
});

interface ResolvedRange {
  from: Date;
  to: Date;
}

function resolveRange(fromStr?: string, toStr?: string): ResolvedRange {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const defaultFrom = new Date(today);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  const from = fromStr ? new Date(`${fromStr}T00:00:00Z`) : defaultFrom;
  // `to` é inclusivo do dia: somamos 1 pra cobrir 23:59.
  const toExclusive = toStr ? new Date(`${toStr}T00:00:00Z`) : new Date(today);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  return { from, to: toExclusive };
}

function isoDayUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /api/units/:id/whatsapp-costs
// ---------------------------------------------------------------------------

export interface WhatsappCostsResponse {
  unit: { id: string; slug: string; name: string; wabaId: string | null };
  range: { from: string; to: string };
  totals: {
    volume: number;
    costUsd: number;
    currency: string;
    rowsCount: number;
  };
  byCategory: Array<{ pricingCategory: string; volume: number; costUsd: number }>;
  byType: Array<{ pricingType: string; volume: number; costUsd: number }>;
  byCountry: Array<{ country: string; volume: number; costUsd: number }>;
  timeline: Array<{ date: string; volume: number; costUsd: number }>;
  budget: {
    monthlyUsd: number;
    spentUsd: number;
    pctUsed: number;
    remainingUsd: number;
    daysIntoMonth: number;
    projectedMonthUsd: number;
    alert: 'ok' | 'warning' | 'danger' | 'over';
  };
  lastSyncedAt: string | null;
}

export async function getWhatsappCostsHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const range = resolveRange(parsed.data.from, parsed.data.to);
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  const rows = await prisma.whatsappCostDaily.findMany({
    where: { unitId, date: { gte: range.from, lt: range.to } },
    select: {
      date: true,
      pricingCategory: true,
      pricingType: true,
      country: true,
      volume: true,
      costUsd: true,
      currency: true,
      syncedAt: true,
    },
    orderBy: { date: 'desc' },
  });

  const byCategoryMap = new Map<string, { volume: number; costUsd: number }>();
  const byTypeMap = new Map<string, { volume: number; costUsd: number }>();
  const byCountryMap = new Map<string, { volume: number; costUsd: number }>();
  const timelineMap = new Map<string, { volume: number; costUsd: number }>();
  let totalVolume = 0;
  let totalCost = 0;
  let currency = 'USD';
  let lastSync: Date | null = null;

  for (const r of rows) {
    const cost = Number(r.costUsd);
    totalVolume += r.volume;
    totalCost += cost;
    currency = r.currency;
    if (!lastSync || r.syncedAt > lastSync) lastSync = r.syncedAt;

    const cat = byCategoryMap.get(r.pricingCategory) ?? { volume: 0, costUsd: 0 };
    cat.volume += r.volume;
    cat.costUsd += cost;
    byCategoryMap.set(r.pricingCategory, cat);

    const typ = byTypeMap.get(r.pricingType) ?? { volume: 0, costUsd: 0 };
    typ.volume += r.volume;
    typ.costUsd += cost;
    byTypeMap.set(r.pricingType, typ);

    if (r.country) {
      const cur = byCountryMap.get(r.country) ?? { volume: 0, costUsd: 0 };
      cur.volume += r.volume;
      cur.costUsd += cost;
      byCountryMap.set(r.country, cur);
    }

    const day = isoDayUTC(r.date);
    const cur = timelineMap.get(day) ?? { volume: 0, costUsd: 0 };
    cur.volume += r.volume;
    cur.costUsd += cost;
    timelineMap.set(day, cur);
  }

  // Orçamento do mês corrente.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const daysIntoMonth = Math.max(1, Math.ceil((Date.now() - monthStart.getTime()) / 86_400_000));
  const monthRows = await prisma.whatsappCostDaily.aggregate({
    where: { unitId, date: { gte: monthStart } },
    _sum: { costUsd: true },
  });
  const spentUsd = Number(monthRows._sum.costUsd ?? 0);
  const monthlyUsd = Number(unit.metaMonthlyBudgetUsd ?? 0);
  const pctUsed = monthlyUsd > 0 ? (spentUsd / monthlyUsd) * 100 : 0;
  const remainingUsd = Math.max(0, monthlyUsd - spentUsd);
  const projectedMonthUsd = daysIntoMonth > 0 ? (spentUsd / daysIntoMonth) * 30 : 0;
  let alert: WhatsappCostsResponse['budget']['alert'] = 'ok';
  if (pctUsed >= 100) alert = 'over';
  else if (pctUsed >= 90) alert = 'danger';
  else if (pctUsed >= 70) alert = 'warning';

  const payload: WhatsappCostsResponse = {
    unit: { id: unit.id, slug: unit.slug, name: unit.name, wabaId: unit.metaWabaId },
    range: { from: isoDayUTC(range.from), to: isoDayUTC(new Date(range.to.getTime() - 1)) },
    totals: { volume: totalVolume, costUsd: totalCost, currency, rowsCount: rows.length },
    byCategory: [...byCategoryMap.entries()]
      .map(([pricingCategory, v]) => ({ pricingCategory, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byType: [...byTypeMap.entries()]
      .map(([pricingType, v]) => ({ pricingType, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byCountry: [...byCountryMap.entries()]
      .map(([country, v]) => ({ country, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 20),
    timeline: [...timelineMap.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    budget: {
      monthlyUsd,
      spentUsd,
      pctUsed,
      remainingUsd,
      daysIntoMonth,
      projectedMonthUsd,
      alert,
    },
    lastSyncedAt: lastSync ? lastSync.toISOString() : null,
  };
  res.json(payload);
}

// ---------------------------------------------------------------------------
// GET /api/units/:id/whatsapp-templates
// ---------------------------------------------------------------------------

export interface WhatsappTemplatesResponse {
  unit: { id: string; slug: string; name: string };
  range: { from: string; to: string };
  totals: { sent: number; delivered: number; read: number; clicked: number; costUsd: number };
  templates: Array<{
    templateId: string;
    templateName: string | null;
    language: string;
    sent: number;
    delivered: number;
    read: number;
    clicked: number;
    costUsd: number;
    deliveryRate: number;
    readRate: number;
    clickRate: number;
  }>;
}

export async function getWhatsappTemplatesHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const range = resolveRange(parsed.data.from, parsed.data.to);
  const unit = await prisma.unit.findUnique({
    where: { id: unitId },
    select: { id: true, slug: true, name: true },
  });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  const rows = await prisma.whatsappTemplateDaily.findMany({
    where: { unitId, date: { gte: range.from, lt: range.to } },
  });

  type Agg = {
    templateId: string;
    templateName: string | null;
    language: string;
    sent: number;
    delivered: number;
    read: number;
    clicked: number;
    costUsd: number;
  };
  const aggMap = new Map<string, Agg>();
  for (const r of rows) {
    const key = `${r.templateId}|${r.language}`;
    const cur = aggMap.get(key) ?? {
      templateId: r.templateId,
      templateName: r.templateName,
      language: r.language,
      sent: 0,
      delivered: 0,
      read: 0,
      clicked: 0,
      costUsd: 0,
    };
    cur.sent += r.sent;
    cur.delivered += r.delivered;
    cur.read += r.read;
    cur.clicked += r.clicked;
    cur.costUsd += Number(r.costUsd);
    // Templates podem ter name preenchido em alguns dias e null em outros.
    if (!cur.templateName && r.templateName) cur.templateName = r.templateName;
    aggMap.set(key, cur);
  }

  const templates = [...aggMap.values()]
    .map((t) => ({
      ...t,
      deliveryRate: t.sent > 0 ? (t.delivered / t.sent) * 100 : 0,
      readRate: t.delivered > 0 ? (t.read / t.delivered) * 100 : 0,
      clickRate: t.delivered > 0 ? (t.clicked / t.delivered) * 100 : 0,
    }))
    .sort((a, b) => b.sent - a.sent);

  const totals = templates.reduce(
    (acc, t) => ({
      sent: acc.sent + t.sent,
      delivered: acc.delivered + t.delivered,
      read: acc.read + t.read,
      clicked: acc.clicked + t.clicked,
      costUsd: acc.costUsd + t.costUsd,
    }),
    { sent: 0, delivered: 0, read: 0, clicked: 0, costUsd: 0 },
  );

  const payload: WhatsappTemplatesResponse = {
    unit,
    range: { from: isoDayUTC(range.from), to: isoDayUTC(new Date(range.to.getTime() - 1)) },
    totals,
    templates,
  };
  res.json(payload);
}

// ---------------------------------------------------------------------------
// POST /api/units/:id/whatsapp-costs/sync — trigger manual.
// ---------------------------------------------------------------------------

export async function syncWhatsappCostsHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const body = syncBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten() });
    return;
  }
  const unit = await prisma.unit.findUnique({
    where: { id: unitId },
    select: { id: true, slug: true, metaWabaId: true, metaAccessToken: true },
  });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.metaWabaId || !unit.metaAccessToken) {
    res.status(400).json({
      error: 'unit_missing_credentials',
      message: 'Configure metaWabaId e metaAccessToken antes de sincronizar.',
    });
    return;
  }
  try {
    const result = await syncUnitWhatsappCosts(unit, {
      lookbackDays: body.data.lookbackDays ?? 7,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, unitId }, 'sync whatsapp costs falhou');
    res.status(500).json({ error: 'sync_failed', message: msg });
  }
}
