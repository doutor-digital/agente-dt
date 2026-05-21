// ============================================================================
// units.controller.ts — CRUD de Units + KPIs.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Endpoints simples consumidos pelo painel "Unidades". Sem auth no MVP —
// roadmap.
//
// Os secrets (tokens) são MASCARADOS na resposta GET. PUT/POST aceitam
// secrets em texto puro, mas se o front mandar o valor mascarado (ex: o
// próprio campo retornado por GET), tratamos como "manter o atual" — assim
// o usuário pode editar o nome sem precisar redigitar a chave.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createKommoClient, KommoApiError } from '../services/kommo.service.js';
import {
  createUnit,
  deleteUnit,
  listUnits,
  maskUnitSecrets,
  updateUnit,
  type UnitInput,
} from '../services/units.service.js';

// ---------------------------------------------------------------------------
// Validação.
// ---------------------------------------------------------------------------

const slugRegex = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

const unitInputBase = {
  slug: z.string().regex(slugRegex, 'slug deve ser kebab-case (a-z, 0-9, -)'),
  name: z.string().min(1).max(120),
  isActive: z.boolean().optional(),
  kommoSubdomain: z.string().nullable().optional(),
  kommoAccessToken: z.string().nullable().optional(),
  kommoSalesbotId: z.coerce.number().int().nullable().optional(),
  kommoReplyFieldId: z.coerce.number().int().nullable().optional(),
  kommoPausedFieldId: z.coerce.number().int().nullable().optional(),
  kommoWonStatusIds: z.array(z.coerce.number().int()).optional(),
  kommoBypassSalesbot: z.boolean().optional(),
  openaiApiKey: z.string().nullable().optional(),
  openaiAdminKey: z.string().nullable().optional(),
  openaiModel: z.string().min(1).optional(),
  openaiAssistantId: z.string().nullable().optional(),
  openaiTemperature: z.number().min(0).max(2).optional(),
  openaiMaxTokens: z.number().int().min(1).max(8192).optional(),
  openaiMonthlyBudgetUsd: z.coerce.number().min(0).max(100_000).optional(),
  metaPhoneNumberId: z.string().nullable().optional(),
  metaAccessToken: z.string().nullable().optional(),
  metaVerifyToken: z.string().nullable().optional(),
  metaAppSecret: z.string().nullable().optional(),
  systemPrompt: z.string().max(20_000).optional(),

  // Wizard
  personaCompanyName: z.string().max(200).nullable().optional(),
  personaTone: z.enum(['casual', 'formal', 'friendly']).nullable().optional(),
  personaGreeting: z.string().max(500).nullable().optional(),
  personaResponseLength: z.enum(['curta', 'normal', 'detalhada']).optional(),
  personaLanguage: z.enum(['pt-BR', 'en-US', 'es-ES', 'fr-FR']).optional(),
  personaResponseDelaySec: z.coerce.number().int().min(0).max(30).optional(),
  personaEmojis: z.array(z.string().min(1).max(8)).max(60).optional(),
  personaEmojiFrequency: z.enum(['low', 'normal', 'high']).optional(),
  // Fontes — textos longos. Tamanho generoso pra acomodar docs ricos.
  sourcePapel: z.string().max(20_000).nullable().optional(),
  sourceProdutos: z.string().max(20_000).nullable().optional(),
  sourceNegocio: z.string().max(20_000).nullable().optional(),
  qualificationEnabled: z.boolean().optional(),
  qualificationHotTag: z.string().max(50).optional(),
  qualificationColdTag: z.string().max(50).optional(),
  handoffEnabled: z.boolean().optional(),
  handoffKeywords: z.array(z.string().min(1).max(50)).max(50).optional(),
  pipelineIntents: z.record(z.string(), z.coerce.number().int().positive()).nullable().optional(),
  contactCollectionEnabled: z.boolean().optional(),
  contactCollectionAfterTurns: z.coerce.number().int().min(1).max(20).optional(),
  welcomeCouponEnabled: z.boolean().optional(),
  welcomeCouponMessage: z.string().max(500).nullable().optional(),
  businessHoursEnabled: z.boolean().optional(),
  businessHoursStart: z.coerce.number().int().min(0).max(23).optional(),
  businessHoursEnd: z.coerce.number().int().min(0).max(23).optional(),
  businessHoursDays: z.array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).optional(),
  businessHoursTimezone: z.string().max(64).optional(),
  outOfHoursMessage: z.string().max(1000).nullable().optional(),
  followUpEnabled: z.boolean().optional(),
  followUpAfterHours: z.coerce.number().int().min(1).max(720).optional(),
  followUpMessage: z.string().max(500).nullable().optional(),
  collectNameEnabled: z.boolean().optional(),
  collectSourceEnabled: z.boolean().optional(),
  collectSourceOptions: z.array(z.string().min(1).max(50)).max(20).optional(),
};

const createSchema = z.object(unitInputBase);
const updateSchema = z.object({
  ...unitInputBase,
  slug: unitInputBase.slug.optional(),
  name: unitInputBase.name.optional(),
}).partial();

// Heurística pra detectar valor mascarado vindo do front e ignorá-lo no PATCH.
function isMasked(v: unknown): boolean {
  return typeof v === 'string' && v.includes('••••');
}

function dropMaskedSecrets<T extends Partial<UnitInput>>(input: T): T {
  const out: Record<string, unknown> = { ...input };
  for (const k of [
    'kommoAccessToken',
    'openaiApiKey',
    'openaiAdminKey',
    'metaAccessToken',
    'metaAppSecret',
    'metaVerifyToken',
  ] as const) {
    if (isMasked(out[k])) delete out[k];
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

export async function listUnitsHandler(req: Request, res: Response): Promise<void> {
  // UNIT_ADMIN só vê sua própria unit. SUPER_ADMIN vê todas.
  let units = await listUnits();
  if (req.user?.role === 'UNIT_ADMIN') {
    units = units.filter((u) => u.id === req.user!.unitId);
  }
  res.json({ units: units.map(maskUnitSecrets) });
}

export async function getUnitHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  res.json({ unit: maskUnitSecrets(unit) });
}

export async function createUnitHandler(req: Request, res: Response): Promise<void> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  try {
    const unit = await createUnit(parsed.data);
    logger.info({ id: unit.id, slug: unit.slug }, 'unit criada');
    res.status(201).json({ unit: maskUnitSecrets(unit) });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'slug_already_exists' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'falha criando unit');
    res.status(500).json({ error: 'create_failed', message: msg });
  }
}

export async function updateUnitHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }
  try {
    const cleaned = dropMaskedSecrets(parsed.data);
    const unit = await updateUnit(id, cleaned);
    logger.info({ id: unit.id }, 'unit atualizada');
    res.json({ unit: maskUnitSecrets(unit) });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'slug_already_exists' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'falha atualizando unit');
    res.status(500).json({ error: 'update_failed', message: msg });
  }
}

export async function deleteUnitHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  try {
    await deleteUnit(id);
    res.status(204).end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'falha deletando unit');
    res.status(500).json({ error: 'delete_failed', message: msg });
  }
}

// ---------------------------------------------------------------------------
// Stats da unidade — usados no card de header do dashboard.
// Retorna totais de execuções, taxa de sucesso, latência média, custo total
// (USD) e tokens consumidos.
// ---------------------------------------------------------------------------

export async function unitStatsHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const sinceDays = Math.min(Number(req.query.days ?? 30), 365);
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const [traces, success, failed, running, traceLatency, llmAgg, llmByModel] = await Promise.all([
    prisma.executionTrace.count({ where: { unitId: id, createdAt: { gte: since } } }),
    prisma.executionTrace.count({ where: { unitId: id, status: 'SUCCESS', createdAt: { gte: since } } }),
    prisma.executionTrace.count({ where: { unitId: id, status: 'FAILED', createdAt: { gte: since } } }),
    prisma.executionTrace.count({ where: { unitId: id, status: 'RUNNING', createdAt: { gte: since } } }),
    prisma.executionTrace.aggregate({
      where: { unitId: id, status: 'SUCCESS', createdAt: { gte: since }, latencyMs: { not: null } },
      _avg: { latencyMs: true },
    }),
    prisma.llmCall.aggregate({
      where: { unitId: id, createdAt: { gte: since } },
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true, costUsd: true, latencyMs: true },
      _count: { _all: true },
    }),
    prisma.llmCall.groupBy({
      where: { unitId: id, createdAt: { gte: since } },
      by: ['model'],
      _count: { _all: true },
      _sum: { totalTokens: true, costUsd: true },
    }),
  ]);

  res.json({
    sinceDays,
    traces: {
      total: traces,
      success,
      failed,
      running,
      successRate: traces > 0 ? success / traces : 0,
      avgLatencyMs: traceLatency._avg.latencyMs ? Math.round(traceLatency._avg.latencyMs) : 0,
    },
    llm: {
      calls: llmAgg._count._all,
      promptTokens: llmAgg._sum.promptTokens ?? 0,
      completionTokens: llmAgg._sum.completionTokens ?? 0,
      totalTokens: llmAgg._sum.totalTokens ?? 0,
      costUsd: Number(llmAgg._sum.costUsd ?? 0),
      avgLatencyMs:
        llmAgg._count._all > 0 && llmAgg._sum.latencyMs
          ? Math.round(llmAgg._sum.latencyMs / llmAgg._count._all)
          : 0,
      byModel: llmByModel.map((m) => ({
        model: m.model,
        calls: m._count._all,
        totalTokens: m._sum.totalTokens ?? 0,
        costUsd: Number(m._sum.costUsd ?? 0),
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// Pipelines do Kommo — usado pelo painel pra mostrar as etapas (statusId+nome)
// que o usuário copia pro system prompt e pra `kommoWonStatusIds`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Custom fields do Kommo (por Unit). Versão moderna do legado
// /admin/kommo-fields, que dependia das credenciais do .env.
// ---------------------------------------------------------------------------

export async function kommoFieldsHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(400).json({ error: 'kommo_not_configured' });
    return;
  }
  try {
    const client = createKommoClient(unit);
    const raw = (await client.listLeadCustomFields()) as {
      _embedded?: { custom_fields?: Array<{ id: number; name: string; type: string; code?: string | null }> };
    };
    const fields = (raw?._embedded?.custom_fields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      code: f.code ?? null,
    }));
    res.json({ ok: true, fields });
  } catch (err) {
    logger.warn({ err, id }, 'kommo-fields (por Unit) falhou');
    res.status(kommoErrorStatus(err)).json(kommoErrorPayload(err));
  }
}

// ---------------------------------------------------------------------------
// Tags de leads do Kommo (por Unit) — usado no painel pra montar dropdowns
// nas regras de automação (aplicar_tag dropdown ao invés de texto livre).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboard executivo — KPIs grandes + funil do pipeline.
// ---------------------------------------------------------------------------

export async function dashboardHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  // Período configurável via ?days=N — default 7 (alinhado com o mock do
  // "ATIVIDADE DO AGENTE DE IA — ÚLTIMOS 7 DIAS"). Clamp [1, 365].
  const daysParam = Number(req.query.days ?? 7);
  const periodDays = Number.isFinite(daysParam)
    ? Math.max(1, Math.min(Math.round(daysParam), 365))
    : 7;

  const now = new Date();
  const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

  // 1 round-trip em paralelo. Cada query é independente.
  const [
    uniqueLeadsRow,
    answeredConvosRow,
    weekendLeadsRow,
    weekendConvosRow,
    handoffRow,
    unansweredRow,
    convertedConvos,
    totalConvos,
    convertedBySdrRow,
    llmAgg,
    convsByHour,
    avgRespLatency,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT lead_id)::bigint AS count
      FROM conversations
      WHERE unit_id = ${id}
        AND last_message_at >= ${periodStart}
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT c.id)::bigint AS count
      FROM conversations c
      WHERE c.unit_id = ${id}
        AND c.last_message_at >= ${periodStart}
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
            AND m.role = 'assistant'
            AND m.created_at >= ${periodStart}
        )
    `,
    // Leads cuja PRIMEIRA mensagem caiu num sábado (6) ou domingo (0).
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT c.lead_id)::bigint AS count
      FROM conversations c
      WHERE c.unit_id = ${id}
        AND c.created_at >= ${periodStart}
        AND EXTRACT(DOW FROM c.created_at) IN (0, 6)
    `,
    // Conversas com QUALQUER mensagem em sábado/domingo no período.
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT c.id)::bigint AS count
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE c.unit_id = ${id}
        AND m.created_at >= ${periodStart}
        AND EXTRACT(DOW FROM m.created_at) IN (0, 6)
    `,
    // Transferências: conversas (leadId distinto) onde rodou step de pausar_ia
    // no período. Match por título — o recorder inscreve "Decisão: pausar IA…".
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT et.lead_id)::bigint AS count
      FROM execution_traces et
      JOIN execution_steps es ON es.trace_id = et.id
      WHERE et.unit_id = ${id}
        AND et.created_at >= ${periodStart}
        AND es.kind = 'TOOL_CALL'
        AND es.title ILIKE 'decisão: pausar%'
    `,
    // Perguntas sem resposta: mensagem do paciente que não recebeu resposta
    // do assistant dentro de 60min na mesma conversa.
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.unit_id = ${id}
        AND m.role = 'user'
        AND m.created_at >= ${periodStart}
        AND NOT EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.conversation_id = m.conversation_id
            AND m2.role = 'assistant'
            AND m2.created_at > m.created_at
            AND m2.created_at < m.created_at + INTERVAL '60 minutes'
        )
    `,
    // Conversões totais (mantém o número agregado, mesmo agora que separamos).
    prisma.conversation.count({
      where: { unitId: id, createdAt: { gte: periodStart }, convertedAt: { not: null } },
    }),
    prisma.conversation.count({
      where: { unitId: id, createdAt: { gte: periodStart } },
    }),
    // Conversões pela SDR: conversa convertida E teve `pausar_ia` (handoff)
    // ANTES do convertedAt. Heurística: lead_id da conversa apareceu num
    // execution_step kind=TOOL_CALL title ILIKE 'decisão: pausar%' antes do
    // converted_at. Como a Conversation guarda leadId (não trace.id), o join
    // é por lead_id+unit_id+created_at — exatamente como o handoffCount já faz.
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT c.id)::bigint AS count
      FROM conversations c
      WHERE c.unit_id = ${id}
        AND c.created_at >= ${periodStart}
        AND c.converted_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM execution_traces et
          JOIN execution_steps es ON es.trace_id = et.id
          WHERE et.unit_id = c.unit_id
            AND et.lead_id = c.lead_id
            AND et.created_at < c.converted_at
            AND es.kind = 'TOOL_CALL'
            AND es.title ILIKE 'decisão: pausar%'
        )
    `,
    prisma.llmCall.aggregate({
      where: { unitId: id, createdAt: { gte: periodStart } },
      _sum: { costUsd: true, totalTokens: true },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ hour: number; count: bigint }>>`
      SELECT EXTRACT(HOUR FROM m."created_at")::int AS hour, COUNT(*)::bigint AS count
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.unit_id = ${id}
        AND m.role = 'user'
        AND m.created_at >= ${periodStart}
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 1
    `,
    prisma.executionTrace.aggregate({
      where: {
        unitId: id,
        status: 'SUCCESS',
        latencyMs: { not: null },
        createdAt: { gte: periodStart },
      },
      _avg: { latencyMs: true },
    }),
  ]);

  const uniqueLeads = Number(uniqueLeadsRow[0]?.count ?? 0);
  const answeredConversations = Number(answeredConvosRow[0]?.count ?? 0);
  const weekendLeads = Number(weekendLeadsRow[0]?.count ?? 0);
  const weekendConversations = Number(weekendConvosRow[0]?.count ?? 0);
  const handoffCount = Number(handoffRow[0]?.count ?? 0);
  const unansweredQuestions = Number(unansweredRow[0]?.count ?? 0);
  const totalCost = Number(llmAgg._sum.costUsd ?? 0);
  const peakHour = convsByHour[0]?.hour ?? null;
  const handoffRate = uniqueLeads > 0 ? handoffCount / uniqueLeads : 0;
  const conversionRate = totalConvos > 0 ? convertedConvos / totalConvos : 0;

  // Split SDR vs IA: SDR = converteu APÓS um handoff (pausar_ia). IA = converteu
  // sozinha (sem handoff antes). É garantido que sdr <= convertedConvos.
  const convertedBySdr = Number(convertedBySdrRow[0]?.count ?? 0);
  const convertedByIa = Math.max(0, convertedConvos - convertedBySdr);
  const conversionRateSdr = totalConvos > 0 ? convertedBySdr / totalConvos : 0;
  const conversionRateIa = totalConvos > 0 ? convertedByIa / totalConvos : 0;

  // Funil: lista leads do Kommo e agrupa por status_id.
  let funnel: Array<{
    pipelineId: number;
    pipelineName: string;
    statuses: Array<{ statusId: number; statusName: string; count: number; color: string | null }>;
  }> = [];
  if (unit.kommoSubdomain && unit.kommoAccessToken) {
    try {
      const client = createKommoClient(unit);
      const [pipelines, leads] = await Promise.all([client.listPipelines(), client.listLeads(4)]);
      const countByStatus = new Map<number, number>();
      for (const lead of leads) {
        if (lead.status_id) countByStatus.set(lead.status_id, (countByStatus.get(lead.status_id) ?? 0) + 1);
      }
      funnel = pipelines
        .filter((p) => !p.is_archive)
        .map((p) => ({
          pipelineId: p.id,
          pipelineName: p.name,
          statuses: p.statuses.map((s) => ({
            statusId: s.id,
            statusName: s.name,
            count: countByStatus.get(s.id) ?? 0,
            color: s.color ?? null,
          })),
        }));
    } catch (err) {
      logger.warn({ err, unitId: id }, 'dashboard: funnel fetch falhou (kommo)');
    }
  }

  res.json({
    periodDays,
    kpis: {
      uniqueLeads,
      answeredConversations,
      weekendLeads,
      weekendConversations,
      handoffCount,
      handoffRate,
      avgResponseLatencyMs: avgRespLatency._avg.latencyMs
        ? Math.round(avgRespLatency._avg.latencyMs)
        : 0,
      unansweredQuestions,
      convertedCount: convertedConvos,
      conversionRate,
      convertedByIa,
      convertedBySdr,
      conversionRateIa,
      conversionRateSdr,
      llmCostUsd: totalCost,
      llmCallsCount: llmAgg._count._all,
      peakHour,
    },
    funnel,
  });
}

// ---------------------------------------------------------------------------
// Preview do system prompt composto — usado pelo WizardPanel pra mostrar ao
// vivo o que a IA vai ler. Aceita um body parcial (`overrides`) que sobrescreve
// campos da Unit corrente sem precisar salvar — assim o leigo vê o efeito das
// mudanças antes de salvar.
// ---------------------------------------------------------------------------

import { composeSystemPrompt } from '../agent/prompt-composer.js';

export async function previewPromptHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  // O body pode trazer overrides parciais — qualquer campo do Unit.
  // Não validamos com rigor: é só preview, nada vai pro banco.
  const overrides = (req.body ?? {}) as Partial<typeof unit>;
  const merged = { ...unit, ...overrides };
  const prompt = composeSystemPrompt({ unit: merged as typeof unit });
  res.json({ prompt, chars: prompt.length });
}

export async function kommoTagsHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(400).json({ error: 'kommo_not_configured' });
    return;
  }
  try {
    const client = createKommoClient(unit);
    const tags = await client.listLeadTags();
    res.json({
      ok: true,
      tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color ?? null })),
    });
  } catch (err) {
    logger.warn({ err, id }, 'kommo-tags (por Unit) falhou');
    res.status(kommoErrorStatus(err)).json(kommoErrorPayload(err));
  }
}

// ---------------------------------------------------------------------------
// Salesbots do Kommo (por Unit).
// ---------------------------------------------------------------------------

export async function kommoSalesbotsHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(400).json({ error: 'kommo_not_configured' });
    return;
  }
  try {
    const client = createKommoClient(unit);
    const raw = (await client.listSalesbots()) as {
      _embedded?: { salesbot?: Array<{ id: number; name: string }> };
    };
    const bots = (raw?._embedded?.salesbot ?? []).map((b) => ({ id: b.id, name: b.name }));
    res.json({ ok: true, bots });
  } catch (err) {
    logger.warn({ err, id }, 'kommo-salesbots (por Unit) falhou');
    res.status(kommoErrorStatus(err)).json(kommoErrorPayload(err));
  }
}

export async function kommoPipelinesHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(400).json({ error: 'kommo_not_configured' });
    return;
  }
  try {
    const client = createKommoClient(unit);
    const pipelines = await client.listPipelines();
    res.json({
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        isMain: !!p.is_main,
        isArchive: !!p.is_archive,
        statuses: p.statuses.map((s) => ({ id: s.id, name: s.name, color: s.color ?? null })),
      })),
    });
  } catch (err) {
    logger.warn({ err, id }, 'kommo-pipelines falhou');
    res.status(kommoErrorStatus(err)).json(kommoErrorPayload(err));
  }
}

// ---------------------------------------------------------------------------
// Helpers — extrai detalhes do erro do Kommo para devolver ao front.
// O front precisa do `kommoBody` pra exibir "Authorization required", "Account
// blocked", etc. Sem isso, só vê "Request failed with status code 401".
// ---------------------------------------------------------------------------

function kommoErrorStatus(err: unknown): number {
  if (err instanceof KommoApiError) return err.status ?? 502;
  return 502;
}

function kommoErrorPayload(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof KommoApiError) {
    return {
      ok: false,
      error: msg,
      kommoStatus: err.status ?? null,
      kommoBody: err.responseBody ?? null,
    };
  }
  return { ok: false, error: msg };
}

// ---------------------------------------------------------------------------
// Validate Kommo — checa se os IDs configurados (salesbot, fields, etapas Won)
// existem de fato na conta. Retorna checklist verde/vermelho pro front.
//
// SOFT: nunca falha o request. Cada checagem reporta seu próprio ok/erro.
// ---------------------------------------------------------------------------

interface KommoCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// GET /api/units/:id/leads-bucket?bucket=unanswered|weekend|handoff|converted_ia|converted_sdr
//
// Devolve a LISTA dos leads/conversas que compõem cada KPI do dashboard —
// permite "drill-down" clicável. As queries SQL espelham as do dashboardHandler
// trocando COUNT por SELECT (mesmo período padrão 7d).
// ---------------------------------------------------------------------------

type BucketRow = {
  conversationId: string;
  leadId: string;
  contactName: string | null;
  phone: string | null;
  lastMessageAt: Date | string;
  createdAt: Date | string;
  convertedAt?: Date | string | null;
  // Texto curto pra mostrar como dica em cada linha (1 linha de contexto).
  hint?: string | null;
};

export async function leadsBucketHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const bucket = String(req.query.bucket ?? '');
  const daysParam = Number(req.query.days ?? 7);
  const periodDays = Number.isFinite(daysParam)
    ? Math.max(1, Math.min(Math.round(daysParam), 365))
    : 7;
  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const limit = 200;

  const allowed = ['unanswered', 'weekend_leads', 'weekend_conversations', 'handoff', 'converted_ia', 'converted_sdr'];
  if (!allowed.includes(bucket)) {
    res.status(400).json({ error: 'invalid_bucket', allowed });
    return;
  }

  let rows: BucketRow[] = [];

  if (bucket === 'unanswered') {
    // Mensagens do paciente sem resposta da IA em 60min. Devolve uma linha
    // por mensagem não respondida (com a conversa+lead correspondente).
    rows = await prisma.$queryRaw<BucketRow[]>`
      SELECT c.id AS "conversationId",
             c.lead_id AS "leadId",
             c.contact_name AS "contactName",
             c.phone AS "phone",
             c.last_message_at AS "lastMessageAt",
             c.created_at AS "createdAt",
             LEFT(m.content, 140) AS "hint"
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.unit_id = ${id}
        AND m.role = 'user'
        AND m.created_at >= ${periodStart}
        AND NOT EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.conversation_id = m.conversation_id
            AND m2.role = 'assistant'
            AND m2.created_at > m.created_at
            AND m2.created_at < m.created_at + INTERVAL '60 minutes'
        )
      ORDER BY m.created_at DESC
      LIMIT ${limit}
    `;
  } else if (bucket === 'weekend_leads') {
    // Lead cuja PRIMEIRA mensagem caiu em sábado/domingo no período.
    rows = await prisma.$queryRaw<BucketRow[]>`
      SELECT c.id AS "conversationId",
             c.lead_id AS "leadId",
             c.contact_name AS "contactName",
             c.phone AS "phone",
             c.last_message_at AS "lastMessageAt",
             c.created_at AS "createdAt",
             TO_CHAR(c.created_at, 'TMDay HH24:MI') AS "hint"
      FROM conversations c
      WHERE c.unit_id = ${id}
        AND c.created_at >= ${periodStart}
        AND EXTRACT(DOW FROM c.created_at) IN (0, 6)
      ORDER BY c.created_at DESC
      LIMIT ${limit}
    `;
  } else if (bucket === 'weekend_conversations') {
    // Conversas com QUALQUER mensagem em sáb/dom no período.
    rows = await prisma.$queryRaw<BucketRow[]>`
      SELECT DISTINCT ON (c.id)
             c.id AS "conversationId",
             c.lead_id AS "leadId",
             c.contact_name AS "contactName",
             c.phone AS "phone",
             c.last_message_at AS "lastMessageAt",
             c.created_at AS "createdAt",
             NULL::text AS "hint"
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE c.unit_id = ${id}
        AND m.created_at >= ${periodStart}
        AND EXTRACT(DOW FROM m.created_at) IN (0, 6)
      ORDER BY c.id, c.last_message_at DESC
      LIMIT ${limit}
    `;
  } else if (bucket === 'handoff') {
    // Conversas que tiveram pausar_ia (handoff pra humano) no período.
    rows = await prisma.$queryRaw<BucketRow[]>`
      SELECT DISTINCT ON (c.id)
             c.id AS "conversationId",
             c.lead_id AS "leadId",
             c.contact_name AS "contactName",
             c.phone AS "phone",
             c.last_message_at AS "lastMessageAt",
             c.created_at AS "createdAt",
             'IA pausada' AS "hint"
      FROM conversations c
      JOIN execution_traces et ON et.unit_id = c.unit_id AND et.lead_id = c.lead_id
      JOIN execution_steps es ON es.trace_id = et.id
      WHERE c.unit_id = ${id}
        AND et.created_at >= ${periodStart}
        AND es.kind = 'TOOL_CALL'
        AND es.title ILIKE 'decisão: pausar%'
      ORDER BY c.id, c.last_message_at DESC
      LIMIT ${limit}
    `;
  } else if (bucket === 'converted_ia') {
    // Convertidos sem handoff prévio.
    rows = await prisma.$queryRaw<BucketRow[]>`
      SELECT c.id AS "conversationId",
             c.lead_id AS "leadId",
             c.contact_name AS "contactName",
             c.phone AS "phone",
             c.last_message_at AS "lastMessageAt",
             c.created_at AS "createdAt",
             c.converted_at AS "convertedAt",
             'Convertido pela IA' AS "hint"
      FROM conversations c
      WHERE c.unit_id = ${id}
        AND c.created_at >= ${periodStart}
        AND c.converted_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM execution_traces et
          JOIN execution_steps es ON es.trace_id = et.id
          WHERE et.unit_id = c.unit_id
            AND et.lead_id = c.lead_id
            AND et.created_at < c.converted_at
            AND es.kind = 'TOOL_CALL'
            AND es.title ILIKE 'decisão: pausar%'
        )
      ORDER BY c.converted_at DESC
      LIMIT ${limit}
    `;
  } else if (bucket === 'converted_sdr') {
    // Convertidos COM handoff prévio (humano fechou).
    rows = await prisma.$queryRaw<BucketRow[]>`
      SELECT c.id AS "conversationId",
             c.lead_id AS "leadId",
             c.contact_name AS "contactName",
             c.phone AS "phone",
             c.last_message_at AS "lastMessageAt",
             c.created_at AS "createdAt",
             c.converted_at AS "convertedAt",
             'Convertido pela SDR (após handoff)' AS "hint"
      FROM conversations c
      WHERE c.unit_id = ${id}
        AND c.created_at >= ${periodStart}
        AND c.converted_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM execution_traces et
          JOIN execution_steps es ON es.trace_id = et.id
          WHERE et.unit_id = c.unit_id
            AND et.lead_id = c.lead_id
            AND et.created_at < c.converted_at
            AND es.kind = 'TOOL_CALL'
            AND es.title ILIKE 'decisão: pausar%'
        )
      ORDER BY c.converted_at DESC
      LIMIT ${limit}
    `;
  }

  res.json({ bucket, periodDays, count: rows.length, items: rows });
}

export async function kommoValidateHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(400).json({ error: 'kommo_not_configured' });
    return;
  }

  const client = createKommoClient(unit);
  const checks: KommoCheck[] = [];

  // 1) Subdomain + token — qualquer chamada serve. Listamos pipelines pq
  //    é leve e reusamos pra validar `kommoWonStatusIds`.
  let pipelines: Awaited<ReturnType<typeof client.listPipelines>> | null = null;
  try {
    pipelines = await client.listPipelines();
    checks.push({ name: 'credentials', ok: true, detail: `${pipelines.length} pipeline(s) carregados` });
  } catch (err) {
    const msg = err instanceof KommoApiError ? `${err.status ?? '?'}: ${err.message}` : (err as Error).message;
    checks.push({ name: 'credentials', ok: false, detail: msg });
  }

  // 2) Salesbot.
  // Algumas contas Kommo não expõem GET /salesbot/{id} via REST (mesma quirk
  // da listagem). Tratamos 404 como "API indisponível, não bloqueante" — o
  // disparo via POST /salesbot/{id}/run continua funcionando.
  if (unit.kommoSalesbotId) {
    try {
      const bot = await client.getSalesbot(unit.kommoSalesbotId);
      checks.push({ name: 'salesbot', ok: true, detail: `"${bot.name}" (#${bot.id})` });
    } catch (err) {
      const status = err instanceof KommoApiError ? err.status : undefined;
      const msg = err instanceof KommoApiError ? `${err.status ?? '?'}: ${err.message}` : (err as Error).message;
      if (status === 404) {
        checks.push({
          name: 'salesbot',
          ok: true,
          detail: `ID #${unit.kommoSalesbotId} salvo. API de leitura indisponível nessa conta — verificação adiada pro disparo em runtime.`,
        });
      } else {
        checks.push({ name: 'salesbot', ok: false, detail: msg });
      }
    }
  } else {
    checks.push({ name: 'salesbot', ok: false, detail: 'kommoSalesbotId não configurado' });
  }

  // 3) Reply field.
  if (unit.kommoReplyFieldId) {
    try {
      const f = await client.getCustomField(unit.kommoReplyFieldId);
      checks.push({ name: 'replyField', ok: true, detail: `"${f.name}" (${f.type})` });
    } catch (err) {
      const msg = err instanceof KommoApiError ? `${err.status ?? '?'}: ${err.message}` : (err as Error).message;
      checks.push({ name: 'replyField', ok: false, detail: msg });
    }
  } else {
    checks.push({ name: 'replyField', ok: false, detail: 'kommoReplyFieldId não configurado' });
  }

  // 4) Paused field (opcional).
  if (unit.kommoPausedFieldId) {
    try {
      const f = await client.getCustomField(unit.kommoPausedFieldId);
      const looksOk = f.type === 'checkbox';
      checks.push({
        name: 'pausedField',
        ok: looksOk,
        detail: looksOk ? `"${f.name}" (checkbox)` : `"${f.name}" tem tipo "${f.type}" — esperado "checkbox"`,
      });
    } catch (err) {
      const msg = err instanceof KommoApiError ? `${err.status ?? '?'}: ${err.message}` : (err as Error).message;
      checks.push({ name: 'pausedField', ok: false, detail: msg });
    }
  } else {
    checks.push({ name: 'pausedField', ok: false, detail: 'kommoPausedFieldId não configurado (opcional)' });
  }

  // 5) Won status IDs — cross-check com os pipelines carregados.
  if (unit.kommoWonStatusIds.length === 0) {
    checks.push({ name: 'wonStatusIds', ok: false, detail: 'nenhum statusId de "Ganho" configurado' });
  } else if (!pipelines) {
    checks.push({ name: 'wonStatusIds', ok: false, detail: 'não foi possível validar (falha em credentials)' });
  } else {
    const validIds = new Set(pipelines.flatMap((p) => p.statuses.map((s) => s.id)));
    const missing = unit.kommoWonStatusIds.filter((sid) => !validIds.has(sid));
    if (missing.length === 0) {
      checks.push({
        name: 'wonStatusIds',
        ok: true,
        detail: `${unit.kommoWonStatusIds.length} status existente(s)`,
      });
    } else {
      checks.push({
        name: 'wonStatusIds',
        ok: false,
        detail: `IDs inexistentes: ${missing.join(', ')}`,
      });
    }
  }

  const allOk = checks.every((c) => c.ok || c.name === 'pausedField'); // pausedField é opcional
  res.json({ ok: allOk, checks });
}
