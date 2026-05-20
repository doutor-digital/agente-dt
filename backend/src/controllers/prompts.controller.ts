// ============================================================================
// prompts.controller.ts — Painel "Prompts" (dimensionamento de qualidade).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cruza conversas convertidas com suas ConversationEvaluations, agrupa por
// `promptHash` e devolve métricas por versão de prompt. É a base do recorte
// que o usuário pediu: "qual prompt converteu qual lead, e com qual
// qualidade".
//
// Não é uma view materializada — agregação ad-hoc em memória. Volume é
// baixo (uma avaliação por lead convertido). Se passar de ~10k, mover pra
// SQL agregado.
// ============================================================================

import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { rawAdminCall } from '../services/openai-platform.service.js';
import {
  judgeConversation,
  JUDGE_CRITERIA,
  type CriterionScores,
} from '../services/conversation-judge.service.js';
import { logger } from '../lib/logger.js';

interface GroupAcc {
  promptHash: string;
  promptSnapshot: string;
  conversions: number;
  evaluations: number;
  scoreSum: CriterionScores & { overall: number };
  costSum: number;
  firstSeen: Date;
  lastSeen: Date;
  topEvaluations: Array<{
    conversationId: string;
    leadId: string;
    contactName: string | null;
    convertedAt: string | null;
    overallScore: number;
    scores: CriterionScores;
    verdict: string;
  }>;
}

// ---------------------------------------------------------------------------
// GET /api/units/:id/prompt-performance
// ---------------------------------------------------------------------------

export async function getPromptPerformanceHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const sinceDays = Math.min(Number(req.query.days ?? 90), 365);
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  // Total de conversas (denominador "tudo") e de convertidas (numerador).
  const [totalConversations, convertedConversations, evaluations] = await Promise.all([
    prisma.conversation.count({ where: { unitId, createdAt: { gte: since } } }),
    prisma.conversation.count({
      where: { unitId, convertedAt: { gte: since, not: null } },
    }),
    prisma.conversationEvaluation.findMany({
      where: { unitId, createdAt: { gte: since } },
      include: {
        conversation: {
          select: {
            id: true,
            leadId: true,
            contactName: true,
            convertedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // Agrupa por promptHash.
  const groups = new Map<string, GroupAcc>();
  for (const ev of evaluations) {
    const conv = ev.conversation;
    const cur = groups.get(ev.promptHash) ?? {
      promptHash: ev.promptHash,
      promptSnapshot: ev.promptSnapshot,
      conversions: 0,
      evaluations: 0,
      scoreSum: { clareza: 0, empatia: 0, objecoes: 0, cta: 0, tom: 0, overall: 0 },
      costSum: 0,
      firstSeen: ev.createdAt,
      lastSeen: ev.createdAt,
      topEvaluations: [],
    };
    const s = ev.scores as unknown as CriterionScores;
    cur.evaluations += 1;
    cur.conversions += 1; // 1 avaliação = 1 conversa convertida
    cur.scoreSum.clareza += s.clareza ?? 0;
    cur.scoreSum.empatia += s.empatia ?? 0;
    cur.scoreSum.objecoes += s.objecoes ?? 0;
    cur.scoreSum.cta += s.cta ?? 0;
    cur.scoreSum.tom += s.tom ?? 0;
    cur.scoreSum.overall += ev.overallScore;
    cur.costSum += Number(ev.costUsd);
    if (ev.createdAt < cur.firstSeen) cur.firstSeen = ev.createdAt;
    if (ev.createdAt > cur.lastSeen) cur.lastSeen = ev.createdAt;
    // Mantém as 5 mais recentes pra visualização rápida no painel.
    cur.topEvaluations.push({
      conversationId: conv.id,
      leadId: conv.leadId,
      contactName: conv.contactName,
      convertedAt: conv.convertedAt?.toISOString() ?? null,
      overallScore: ev.overallScore,
      scores: s,
      verdict: ev.verdict,
    });
    groups.set(ev.promptHash, cur);
  }

  const prompts = [...groups.values()]
    .map((g) => {
      const n = g.evaluations || 1;
      return {
        promptHash: g.promptHash,
        promptSnapshot: g.promptSnapshot,
        conversions: g.conversions,
        evaluations: g.evaluations,
        avgScores: {
          clareza: round1(g.scoreSum.clareza / n),
          empatia: round1(g.scoreSum.empatia / n),
          objecoes: round1(g.scoreSum.objecoes / n),
          cta: round1(g.scoreSum.cta / n),
          tom: round1(g.scoreSum.tom / n),
        },
        avgOverall: round1(g.scoreSum.overall / n),
        totalCostUsd: round6(g.costSum),
        firstSeen: g.firstSeen.toISOString(),
        lastSeen: g.lastSeen.toISOString(),
        topEvaluations: g.topEvaluations.slice(0, 5),
      };
    })
    .sort((a, b) => b.conversions - a.conversions);

  res.json({
    sinceDays,
    totals: {
      conversations: totalConversations,
      converted: convertedConversations,
      evaluated: evaluations.length,
      pendingJudge: convertedConversations - evaluations.length,
      conversionRate: totalConversations > 0 ? convertedConversations / totalConversations : 0,
    },
    criteria: JUDGE_CRITERIA,
    prompts,
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// GET /api/conversations/:id/evaluation
// ---------------------------------------------------------------------------

export async function getConversationEvaluationHandler(req: Request, res: Response): Promise<void> {
  const conversationId = String(req.params.id ?? '');
  // UNIT_ADMIN só vê avaliações de conversas da própria unit.
  if (req.user?.role === 'UNIT_ADMIN') {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { unitId: true },
    });
    if (!conv || conv.unitId !== req.user.unitId) {
      res.status(404).json({ error: 'evaluation_not_found' });
      return;
    }
  }
  const ev = await prisma.conversationEvaluation.findUnique({
    where: { conversationId },
  });
  if (!ev) {
    res.status(404).json({ error: 'evaluation_not_found' });
    return;
  }
  res.json({
    evaluation: {
      ...ev,
      costUsd: Number(ev.costUsd),
    },
    criteria: JUDGE_CRITERIA,
  });
}

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/evaluate
// Re-roda o juiz (mesmo se já avaliada). Útil quando o usuário editou o
// systemPrompt e quer reavaliar uma conversa específica.
// ---------------------------------------------------------------------------

export async function reEvaluateConversationHandler(req: Request, res: Response): Promise<void> {
  const conversationId = String(req.params.id ?? '');
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) {
    res.status(404).json({ error: 'conversation_not_found' });
    return;
  }
  // UNIT_ADMIN só re-avalia conversas da própria unit.
  if (req.user?.role === 'UNIT_ADMIN' && conv.unitId !== req.user.unitId) {
    res.status(404).json({ error: 'conversation_not_found' });
    return;
  }
  const unit = await prisma.unit.findUnique({ where: { id: conv.unitId } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  // Idempotente por design; pra forçar, deletamos a row antiga.
  await prisma.conversationEvaluation.deleteMany({ where: { conversationId } });
  const result = await judgeConversation({ conversationId, unit });
  if (!result) {
    res.status(500).json({ error: 'judge_failed' });
    return;
  }
  res.json({ ok: true, result });
}

// ---------------------------------------------------------------------------
// GET /api/units/:id/openai-debug
//
// Diagnóstico cru das 3 chamadas administrativas da OpenAI. Devolve status
// HTTP + corpo bruto pra entender exatamente por que o adminKey não está
// trazendo dados.
// ---------------------------------------------------------------------------

export async function openaiDebugHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.openaiAdminKey) {
    res.json({
      adminKey: { configured: false },
      message: 'Unit sem openaiAdminKey configurada — configure em Unidades.',
    });
    return;
  }

  const startTime = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
  const [costs, usage, projects] = await Promise.all([
    rawAdminCall(unit.openaiAdminKey, '/organization/costs', {
      start_time: startTime,
      bucket_width: '1d',
      group_by: 'project_id',
      limit: 30,
    }),
    rawAdminCall(unit.openaiAdminKey, '/organization/usage/completions', {
      start_time: startTime,
      bucket_width: '1d',
      group_by: 'model',
      limit: 30,
    }),
    rawAdminCall(unit.openaiAdminKey, '/organization/projects', {}),
  ]);

  logger.info(
    {
      unitId: id,
      costsStatus: costs.status,
      usageStatus: usage.status,
      projectsStatus: projects.status,
    },
    'openai-debug executado',
  );

  // Diagnóstico textual pra UI mostrar conclusão clara.
  const diagnosis = diagnose(costs, usage, projects);

  res.json({
    adminKey: {
      configured: true,
      preview: `${unit.openaiAdminKey.slice(0, 8)}…${unit.openaiAdminKey.slice(-4)}`,
    },
    diagnosis,
    calls: {
      costs: { path: '/organization/costs', ...costs },
      usage: { path: '/organization/usage/completions', ...usage },
      projects: { path: '/organization/projects', ...projects },
    },
  });
}

function diagnose(
  costs: { status: number | null; body: unknown; error?: string },
  usage: { status: number | null; body: unknown; error?: string },
  projects: { status: number | null; body: unknown; error?: string },
): { conclusion: string; severity: 'ok' | 'warning' | 'danger' } {
  const allUnauth = [costs.status, usage.status, projects.status].every((s) => s === 401);
  if (allUnauth) {
    return {
      severity: 'danger',
      conclusion:
        'A Admin key foi recusada (401) em todos os endpoints. Possíveis causas: (a) key inválida/revogada, (b) é uma project key (sk-proj-…) em vez de admin (sk-admin-…), (c) você está numa organização diferente. Gere uma nova em Settings → Admin keys com permissão de leitura em "API costs" e "API usage".',
    };
  }

  const allForbidden = [costs.status, usage.status, projects.status].every((s) => s === 403);
  if (allForbidden) {
    return {
      severity: 'danger',
      conclusion:
        'A Admin key foi aceita mas não tem permissão (403). Edite a key em Settings → Admin keys e marque os scopes "api.usage.read" e "api.costs.read".',
    };
  }

  const allOk = costs.status === 200 && usage.status === 200 && projects.status === 200;
  if (allOk) {
    const hasCostsData = countItems(costs.body) > 0;
    const hasUsageData = countItems(usage.body) > 0;
    if (!hasCostsData && !hasUsageData) {
      return {
        severity: 'warning',
        conclusion:
          'Tudo OK (HTTP 200) mas a organização não tem consumo registrado nos últimos 30 dias. Costs/usage da OpenAI têm ~24h de latência — se você acabou de usar a key, espere amanhã.',
      };
    }
    return { severity: 'ok', conclusion: 'Admin key funcional e org com dados.' };
  }

  return {
    severity: 'warning',
    conclusion: `Respostas mistas — costs:${costs.status} usage:${usage.status} projects:${projects.status}. Veja o corpo cru abaixo pra detalhes.`,
  };
}

function countItems(body: unknown): number {
  const b = body as { data?: unknown[] };
  return Array.isArray(b?.data) ? b!.data!.length : 0;
}
