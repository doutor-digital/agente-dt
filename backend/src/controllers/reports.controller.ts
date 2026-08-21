import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { buildCsv, buildPdf, reportFilename, type ReportRow, type ReportSpec } from '../lib/reports.js';

const querySchema = z.object({
  format: z.enum(['csv', 'pdf']).default('csv'),
  unitId: z.string().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function resolveRange(from?: string, to?: string): { from: Date; to: Date } {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const defaultFrom = new Date(today);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  const start = from ? new Date(`${from}T00:00:00Z`) : defaultFrom;
  const endExclusive = to ? new Date(`${to}T00:00:00Z`) : new Date(today);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { from: start, to: endExclusive };
}

function resolveUnitScope(req: Request, queryUnitId?: string): { unitId: string | null; locked: boolean } {
  const user = req.user!;
  if (user.role === 'SUPER_ADMIN') {
    return { unitId: queryUnitId ?? null, locked: false };
  }
  return { unitId: user.unitId, locked: true };
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fmtDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

async function sendReport(
  res: Response,
  format: 'csv' | 'pdf',
  slug: string,
  spec: ReportSpec,
  range: { from: Date; to: Date },
): Promise<void> {
  const filename = reportFilename(slug, format, range);
  if (format === 'csv') {
    const body = buildCsv(spec);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
    return;
  }
  const pdf = await buildPdf(spec);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(pdf.byteLength));
  res.end(pdf);
}

export async function reportConversationsHandler(req: Request, res: Response): Promise<void> {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { format, from: fromStr, to: toStr } = parsed.data;
  const range = resolveRange(fromStr, toStr);
  const scope = resolveUnitScope(req, parsed.data.unitId);

  const where = {
    createdAt: { gte: range.from, lt: range.to },
    ...(scope.unitId ? { unitId: scope.unitId } : {}),
  };

  const convs = await prisma.conversation.findMany({
    where,
    select: {
      id: true,
      unitId: true,
      leadId: true,
      contactName: true,
      channel: true,
      createdAt: true,
      lastMessageAt: true,
      convertedAt: true,
      convertedStatusId: true,
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const unitIds = [...new Set(convs.map((c) => c.unitId))];
  const units = unitIds.length
    ? await prisma.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, slug: true } })
    : [];
  const unitSlug = new Map(units.map((u) => [u.id, u.slug]));

  const rows: ReportRow[] = convs.map((c) => ({
    unit: unitSlug.get(c.unitId) ?? c.unitId,
    leadId: c.leadId,
    contato: c.contactName ?? '',
    canal: c.channel,
    msgs: c._count.messages,
    aberta_em: fmtDateTime(c.createdAt),
    ultima_msg: fmtDateTime(c.lastMessageAt),
    convertida: c.convertedAt ? '✓' : '',
    convertida_em: c.convertedAt ? fmtDateTime(c.convertedAt) : '',
    status_conversao: c.convertedStatusId ?? '',
  }));

  const totalConvs = convs.length;
  const totalConverted = convs.filter((c) => c.convertedAt).length;
  const rate = totalConvs > 0 ? ((totalConverted / totalConvs) * 100).toFixed(1) : '0.0';

  const spec: ReportSpec = {
    title: 'Conversas & Conversão',
    subtitle: `Período: ${fmtDate(range.from)} → ${fmtDate(
      new Date(range.to.getTime() - 1),
    )} · ${scope.unitId ? `Unit: ${unitSlug.get(scope.unitId) ?? scope.unitId}` : 'Todas as units'} · ${totalConvs} conversas · ${totalConverted} convertidas (${rate}%)`,
    columns: [
      { key: 'unit', label: 'Unit', width: 1 },
      { key: 'leadId', label: 'Lead', width: 1 },
      { key: 'contato', label: 'Contato', width: 2 },
      { key: 'canal', label: 'Canal', width: 1 },
      { key: 'msgs', label: 'Msgs', width: 0.6 },
      { key: 'aberta_em', label: 'Aberta em', width: 1.4 },
      { key: 'ultima_msg', label: 'Última msg', width: 1.4 },
      { key: 'convertida', label: 'Convert.', width: 0.6 },
      { key: 'convertida_em', label: 'Convertida em', width: 1.4 },
      { key: 'status_conversao', label: 'Status', width: 0.6 },
    ],
    rows,
    footer: `Gerado em ${fmtDateTime(new Date())} · ${totalConvs} linhas`,
  };

  await sendReport(res, format, 'conversas', spec, range);
}

export async function reportLlmCostHandler(req: Request, res: Response): Promise<void> {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { format, from: fromStr, to: toStr } = parsed.data;
  const range = resolveRange(fromStr, toStr);
  const scope = resolveUnitScope(req, parsed.data.unitId);

  const rawAggregates = await prisma.llmCall.groupBy({
    by: ['unitId', 'model'],
    where: {
      createdAt: { gte: range.from, lt: range.to },
      ...(scope.unitId ? { unitId: scope.unitId } : {}),
      status: 'success',
    },
    _sum: {
      promptTokens: true,
      completionTokens: true,
      totalTokens: true,
      costUsd: true,
    },
    _count: true,
  });

  const unitIds = [...new Set(rawAggregates.map((a) => a.unitId).filter((u): u is string => !!u))];
  const units = unitIds.length
    ? await prisma.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, slug: true } })
    : [];
  const unitSlug = new Map(units.map((u) => [u.id, u.slug]));

  const rows: ReportRow[] = rawAggregates.map((a) => ({
    unit: a.unitId ? unitSlug.get(a.unitId) ?? a.unitId : '(global)',
    model: a.model,
    calls: a._count,
    prompt_tokens: a._sum.promptTokens ?? 0,
    completion_tokens: a._sum.completionTokens ?? 0,
    total_tokens: a._sum.totalTokens ?? 0,
    cost_usd: (a._sum.costUsd?.toNumber() ?? 0).toFixed(6),
  }));
  rows.sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd));

  const totalCost = rawAggregates.reduce((sum, a) => sum + (a._sum.costUsd?.toNumber() ?? 0), 0);
  const totalCalls = rawAggregates.reduce((sum, a) => sum + a._count, 0);
  const totalTokens = rawAggregates.reduce((sum, a) => sum + (a._sum.totalTokens ?? 0), 0);

  const spec: ReportSpec = {
    title: 'Custo & Uso da IA',
    subtitle: `Período: ${fmtDate(range.from)} → ${fmtDate(
      new Date(range.to.getTime() - 1),
    )} · ${scope.unitId ? `Unit: ${unitSlug.get(scope.unitId) ?? scope.unitId}` : 'Todas as units'} · ${totalCalls} chamadas · ${totalTokens.toLocaleString('pt-BR')} tokens · $${totalCost.toFixed(4)}`,
    columns: [
      { key: 'unit', label: 'Unit', width: 1 },
      { key: 'model', label: 'Modelo', width: 1.2 },
      { key: 'calls', label: 'Chamadas', width: 0.8 },
      { key: 'prompt_tokens', label: 'Prompt toks', width: 1 },
      { key: 'completion_tokens', label: 'Compl. toks', width: 1 },
      { key: 'total_tokens', label: 'Total toks', width: 1 },
      { key: 'cost_usd', label: 'Custo USD', width: 1 },
    ],
    rows,
    footer: `Gerado em ${fmtDateTime(new Date())}`,
  };

  await sendReport(res, format, 'custo-ia', spec, range);
}

export async function reportActionsHandler(req: Request, res: Response): Promise<void> {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { format, from: fromStr, to: toStr } = parsed.data;
  const range = resolveRange(fromStr, toStr);
  const scope = resolveUnitScope(req, parsed.data.unitId);

  const steps = await prisma.executionStep.findMany({
    where: {
      createdAt: { gte: range.from, lt: range.to },
      kind: 'KOMMO_ACTION',
      ...(scope.unitId
        ? { trace: { unitId: scope.unitId } }
        : {}),
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      payload: true,
      trace: { select: { unitId: true, leadId: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  const unitIds = [...new Set(steps.map((s) => s.trace?.unitId).filter((u): u is string => !!u))];
  const units = unitIds.length
    ? await prisma.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, slug: true } })
    : [];
  const unitSlug = new Map(units.map((u) => [u.id, u.slug]));

  const rows: ReportRow[] = steps.map((s) => {
    const payload = (s.payload as Record<string, unknown> | null) ?? {};
    return {
      data: fmtDateTime(s.createdAt),
      unit: s.trace?.unitId ? unitSlug.get(s.trace.unitId) ?? s.trace.unitId : '',
      lead: s.trace?.leadId ?? '',
      acao: s.title,
      tags: Array.isArray(payload.tags) ? (payload.tags as string[]).join(', ') : (payload.tag as string | undefined) ?? '',
      etapa:
        typeof payload.statusId === 'number'
          ? payload.statusId
          : typeof payload.statusLabel === 'string'
            ? payload.statusLabel
            : '',
      via: (payload.via as string | undefined) ?? '',
    };
  });

  const spec: ReportSpec = {
    title: 'Ações Disparadas pela IA',
    subtitle: `Período: ${fmtDate(range.from)} → ${fmtDate(
      new Date(range.to.getTime() - 1),
    )} · ${scope.unitId ? `Unit: ${unitSlug.get(scope.unitId) ?? scope.unitId}` : 'Todas as units'} · ${rows.length} ações${rows.length === 5000 ? ' (capped)' : ''}`,
    columns: [
      { key: 'data', label: 'Data', width: 1.4 },
      { key: 'unit', label: 'Unit', width: 1 },
      { key: 'lead', label: 'Lead', width: 1 },
      { key: 'acao', label: 'Ação', width: 3.5 },
      { key: 'tags', label: 'Tags', width: 1.5 },
      { key: 'etapa', label: 'Etapa', width: 1 },
      { key: 'via', label: 'Via', width: 0.8 },
    ],
    rows,
    footer: `Gerado em ${fmtDateTime(new Date())}`,
  };

  await sendReport(res, format, 'acoes-ia', spec, range);
}

export async function reportErrorsHandler(req: Request, res: Response): Promise<void> {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { format, from: fromStr, to: toStr } = parsed.data;
  const range = resolveRange(fromStr, toStr);
  const scope = resolveUnitScope(req, parsed.data.unitId);

  const [llmErrors, stepErrors] = await Promise.all([
    prisma.llmCall.findMany({
      where: {
        createdAt: { gte: range.from, lt: range.to },
        status: 'error',
        ...(scope.unitId ? { unitId: scope.unitId } : {}),
      },
      select: {
        id: true,
        createdAt: true,
        unitId: true,
        model: true,
        errorMessage: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 2500,
    }),
    prisma.executionStep.findMany({
      where: {
        createdAt: { gte: range.from, lt: range.to },
        kind: 'ERROR',
        ...(scope.unitId ? { trace: { unitId: scope.unitId } } : {}),
      },
      select: {
        id: true,
        title: true,
        createdAt: true,
        trace: { select: { unitId: true, leadId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 2500,
    }),
  ]);

  const unitIds = [
    ...new Set([
      ...llmErrors.map((e) => e.unitId),
      ...stepErrors.map((e) => e.trace?.unitId),
    ].filter((u): u is string => !!u)),
  ];
  const units = unitIds.length
    ? await prisma.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, slug: true } })
    : [];
  const unitSlug = new Map(units.map((u) => [u.id, u.slug]));

  const rows: ReportRow[] = [
    ...llmErrors.map((e) => ({
      data: fmtDateTime(e.createdAt),
      unit: e.unitId ? unitSlug.get(e.unitId) ?? e.unitId : '',
      origem: 'LLM',
      lead: '',
      contexto: e.model,
      mensagem: e.errorMessage ?? '',
    })),
    ...stepErrors.map((e) => ({
      data: fmtDateTime(e.createdAt),
      unit: e.trace?.unitId ? unitSlug.get(e.trace.unitId) ?? e.trace.unitId : '',
      origem: 'Agente',
      lead: e.trace?.leadId ?? '',
      contexto: '',
      mensagem: e.title,
    })),
  ].sort((a, b) => (a.data < b.data ? 1 : -1));

  const spec: ReportSpec = {
    title: 'Erros & Falhas',
    subtitle: `Período: ${fmtDate(range.from)} → ${fmtDate(
      new Date(range.to.getTime() - 1),
    )} · ${scope.unitId ? `Unit: ${unitSlug.get(scope.unitId) ?? scope.unitId}` : 'Todas as units'} · ${rows.length} erros`,
    columns: [
      { key: 'data', label: 'Data', width: 1.4 },
      { key: 'unit', label: 'Unit', width: 1 },
      { key: 'origem', label: 'Origem', width: 0.8 },
      { key: 'lead', label: 'Lead', width: 1 },
      { key: 'contexto', label: 'Contexto', width: 1.5 },
      { key: 'mensagem', label: 'Mensagem', width: 4 },
    ],
    rows,
    footer: `Gerado em ${fmtDateTime(new Date())}`,
  };

  await sendReport(res, format, 'erros', spec, range);
}

export async function reportWhatsappCostHandler(req: Request, res: Response): Promise<void> {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { format, from: fromStr, to: toStr } = parsed.data;
  const range = resolveRange(fromStr, toStr);
  const scope = resolveUnitScope(req, parsed.data.unitId);

  const aggregates = await prisma.whatsappCostDaily.groupBy({
    by: ['unitId', 'pricingCategory', 'pricingType', 'country'],
    where: {
      date: { gte: range.from, lt: range.to },
      ...(scope.unitId ? { unitId: scope.unitId } : {}),
    },
    _sum: { volume: true, costUsd: true },
    _count: true,
  });

  const unitIds = [...new Set(aggregates.map((a) => a.unitId))];
  const units = unitIds.length
    ? await prisma.unit.findMany({
        where: { id: { in: unitIds } },
        select: { id: true, slug: true },
      })
    : [];
  const unitSlug = new Map(units.map((u) => [u.id, u.slug]));

  const rows: ReportRow[] = aggregates.map((a) => ({
    unit: unitSlug.get(a.unitId) ?? a.unitId,
    categoria: a.pricingCategory,
    tipo: a.pricingType,
    pais: a.country || '(agregado)',
    volume: a._sum.volume ?? 0,
    custo_usd: (a._sum.costUsd?.toNumber() ?? 0).toFixed(6),
  }));
  rows.sort((a, b) => Number(b.custo_usd) - Number(a.custo_usd));

  const totalVolume = aggregates.reduce((sum, a) => sum + (a._sum.volume ?? 0), 0);
  const totalCost = aggregates.reduce((sum, a) => sum + (a._sum.costUsd?.toNumber() ?? 0), 0);

  const spec: ReportSpec = {
    title: 'Custo WhatsApp (Meta)',
    subtitle: `Período: ${fmtDate(range.from)} → ${fmtDate(
      new Date(range.to.getTime() - 1),
    )} · ${scope.unitId ? `Unit: ${unitSlug.get(scope.unitId) ?? scope.unitId}` : 'Todas as units'} · ${totalVolume.toLocaleString('pt-BR')} mensagens · $${totalCost.toFixed(4)}`,
    columns: [
      { key: 'unit', label: 'Unit', width: 1 },
      { key: 'categoria', label: 'Categoria', width: 1.4 },
      { key: 'tipo', label: 'Tipo', width: 1.2 },
      { key: 'pais', label: 'País', width: 0.8 },
      { key: 'volume', label: 'Mensagens', width: 1 },
      { key: 'custo_usd', label: 'Custo USD', width: 1 },
    ],
    rows,
    footer: `Gerado em ${fmtDateTime(new Date())} · fonte: Meta pricing_analytics`,
  };

  await sendReport(res, format, 'custo-whatsapp', spec, range);
}

export function registerReportsLogging(): void {
  logger.debug({ module: 'reports' }, 'reports controller registrado');
}
