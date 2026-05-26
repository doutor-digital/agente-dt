// ============================================================================
// integrations.controller.ts — Central de Integrações (por Unit).
//
// LÓGICA DE ENGENHARIA — O QUE COMPOMOS
// -------------------------------------
// Para cada integração da Unit, retornamos um "card" com:
//   - status      : 'ok' | 'warning' | 'danger' | 'idle'
//   - configured  : boolean (se a unidade preencheu credenciais)
//   - data        : objeto específico de cada provider
//   - alerts[]    : lista de strings legíveis pra exibir no painel
//
// PROVIDERS
// ---------
//   OPENAI:
//     - configured: tem openaiApiKey?
//     - reach: ping em /v1/models (qualquer key serve)
//     - platform: dados REAIS via Admin key (/organization/costs + /usage)
//     - measured: o que NÓS medimos via LlmCall (sempre disponível)
//     - budget: comparado com openaiMonthlyBudgetUsd (alerta 70%/90%/100%)
//     - assistantId
//
//   KOMMO:
//     - configured: tem subdomain + token?
//     - reach: GET /api/v4/account → 200 ok
//     - subdomain
//
//   META:
//     - configured: tem phone_number_id + access_token?
//     - missing: lista do que falta
//
// ALERTAS
// -------
// Cada card pode emitir alerts. O endpoint /api/alerts agrega todos os
// alerts ATIVOS de TODAS as Units (visão admin) — usado pelo badge no
// header do dashboard.
// ============================================================================

import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { OpenAIPlatform } from '../services/openai-platform.service.js';
import { createKommoClient } from '../services/kommo.service.js';
import { getStaleReplies, getDeliveryStatus } from '../lib/stale-reply-monitor.js';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Tipos públicos.
// ---------------------------------------------------------------------------

export type CardStatus = 'ok' | 'warning' | 'danger' | 'idle';

export interface OpenAICard {
  configured: boolean;
  status: CardStatus;
  apiKey: { configured: boolean; reachable: boolean | null; modelCount: number | null; sampleModels: string[]; error?: string };
  adminKey: { configured: boolean; usable: boolean | null; error?: string };
  assistantId: string | null;
  model: string;
  // Gastos REAIS via Admin key (null se sem admin)
  platform: null | {
    sinceDays: number;
    totalCostUsd: number;
    todayCostUsd: number;
    last7DaysCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    numRequests: number;
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; numRequests: number }>;
    timeline: Array<{ date: string; costUsd: number; tokens: number; requests: number }>;
    projects?: Array<{ id: string; name: string; status: string }>;
  };
  // Gastos MEDIDOS (sempre, vem do nosso LlmCall)
  measured: {
    sinceDays: number;
    totalCostUsd: number;
    last7DaysCostUsd: number;
    todayCostUsd: number;
    totalTokens: number;
    numCalls: number;
    byModel: Array<{ model: string; calls: number; totalTokens: number; costUsd: number }>;
    timeline: Array<{ date: string; costUsd: number; tokens: number; calls: number }>;
  };
  // Comparativo (quando platform existe): % do total da OpenAI que vem do agente
  agentShare: null | { percentOfRequests: number; percentOfCost: number };
  // Orçamento mensal
  budget: {
    monthlyUsd: number;
    spentUsd: number; // usa platform se houver, senão measured
    spentSource: 'platform' | 'measured';
    pctUsed: number;
    remainingUsd: number;
    daysIntoMonth: number;
    projectedMonthUsd: number;
    alert: 'ok' | 'warning' | 'danger' | 'over';
  };
  alerts: string[];
}

export interface KommoCard {
  configured: boolean;
  status: CardStatus;
  subdomain: string | null;
  reachable: boolean | null;
  account: null | { id?: number; name?: string; subdomain?: string };
  error?: string;
  alerts: string[];
}

export interface MetaCard {
  configured: boolean;
  status: CardStatus;
  phoneNumberId: string | null;
  wabaId: string | null;
  hasAccessToken: boolean;
  webhookUrl: string;
  // Custo do mês corrente (vem da tabela whatsapp_cost_daily — populada
  // pelo sync diário). null se WABA não está configurada ou sem dados ainda.
  cost: null | {
    monthSpentUsd: number;
    monthVolume: number;
    todayCostUsd: number;
    todayVolume: number;
    last7DaysCostUsd: number;
    last7DaysVolume: number;
    byCategory: Array<{ pricingCategory: string; volume: number; costUsd: number }>;
    lastSyncedAt: string | null;
  };
  budget: {
    monthlyUsd: number;
    spentUsd: number;
    pctUsed: number;
    remainingUsd: number;
    daysIntoMonth: number;
    projectedMonthUsd: number;
    alert: 'ok' | 'warning' | 'danger' | 'over';
  };
  alerts: string[];
}

export interface IntegrationsResponse {
  unit: { id: string; slug: string; name: string };
  generatedAt: string;
  openai: OpenAICard;
  kommo: KommoCard;
  meta: MetaCard;
  alerts: Array<{ severity: 'info' | 'warning' | 'danger'; integration: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Helpers de agregação dos LlmCalls (gastos medidos).
// ---------------------------------------------------------------------------

interface MeasuredAgg {
  totalCostUsd: number;
  totalTokens: number;
  numCalls: number;
  byModel: Map<string, { calls: number; totalTokens: number; costUsd: number }>;
  timeline: Map<string, { costUsd: number; tokens: number; calls: number }>;
}

function isoDayUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function measuredAggregate(unitId: string, sinceDays: number): Promise<MeasuredAgg> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const calls = await prisma.llmCall.findMany({
    where: { unitId, createdAt: { gte: since } },
    select: { model: true, totalTokens: true, costUsd: true, createdAt: true },
  });
  const agg: MeasuredAgg = {
    totalCostUsd: 0,
    totalTokens: 0,
    numCalls: 0,
    byModel: new Map(),
    timeline: new Map(),
  };
  for (const c of calls) {
    const cost = Number(c.costUsd);
    agg.totalCostUsd += cost;
    agg.totalTokens += c.totalTokens;
    agg.numCalls += 1;
    const m = agg.byModel.get(c.model) ?? { calls: 0, totalTokens: 0, costUsd: 0 };
    m.calls += 1;
    m.totalTokens += c.totalTokens;
    m.costUsd += cost;
    agg.byModel.set(c.model, m);
    const day = isoDayUTC(c.createdAt);
    const t = agg.timeline.get(day) ?? { costUsd: 0, tokens: 0, calls: 0 };
    t.costUsd += cost;
    t.tokens += c.totalTokens;
    t.calls += 1;
    agg.timeline.set(day, t);
  }
  return agg;
}

function sumWithinDays<T>(items: T[], getDate: (t: T) => Date, getValue: (t: T) => number, days: number): number {
  const cutoff = Date.now() - days * 86_400_000;
  return items.filter((i) => getDate(i).getTime() >= cutoff).reduce((s, i) => s + getValue(i), 0);
}

// ---------------------------------------------------------------------------
// Builders — um por integração.
// ---------------------------------------------------------------------------

async function buildOpenAICard(unit: Unit, sinceDays: number): Promise<OpenAICard> {
  const ping = await OpenAIPlatform.pingOpenAI(unit.openaiApiKey);

  const platformCosts = await OpenAIPlatform.getCosts(unit.openaiAdminKey, sinceDays);
  const platformUsage = await OpenAIPlatform.getUsageCompletions(unit.openaiAdminKey, sinceDays);
  const platformProjects = unit.openaiAdminKey
    ? await OpenAIPlatform.listProjects(unit.openaiAdminKey)
    : { ok: false, projects: [] as Array<{ id: string; name: string; status: string }> };
  const adminKeyUsable = platformCosts.ok || platformUsage.ok;

  // Pré-processa platform (se Admin key funcionou).
  let platform: OpenAICard['platform'] = null;
  if (platformCosts.ok || platformUsage.ok) {
    // Junta costs + usage por dia (chave = startTime do dia).
    const timelineMap = new Map<string, { date: string; costUsd: number; tokens: number; requests: number }>();
    for (const b of platformCosts.buckets) {
      const date = isoDayUTC(new Date(b.startTime * 1000));
      const cur = timelineMap.get(date) ?? { date, costUsd: 0, tokens: 0, requests: 0 };
      cur.costUsd += b.amountUsd;
      timelineMap.set(date, cur);
    }
    for (const b of platformUsage.buckets) {
      const date = isoDayUTC(new Date(b.startTime * 1000));
      const cur = timelineMap.get(date) ?? { date, costUsd: 0, tokens: 0, requests: 0 };
      cur.tokens += b.inputTokens + b.outputTokens;
      cur.requests += b.numRequests;
      timelineMap.set(date, cur);
    }
    const timeline = [...timelineMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const todayStr = isoDayUTC(new Date());
    const todayCostUsd = timelineMap.get(todayStr)?.costUsd ?? 0;
    const last7 = sumWithinDays(
      platformCosts.buckets,
      (b) => new Date(b.startTime * 1000),
      (b) => b.amountUsd,
      7,
    );
    platform = {
      sinceDays,
      totalCostUsd: platformCosts.totalUsd,
      todayCostUsd,
      last7DaysCostUsd: last7,
      inputTokens: platformUsage.totals.inputTokens,
      outputTokens: platformUsage.totals.outputTokens,
      totalTokens: platformUsage.totals.totalTokens,
      numRequests: platformUsage.totals.numRequests,
      byModel: platformUsage.byModel.map((m) => ({
        model: m.model,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        numRequests: m.numRequests,
      })),
      timeline,
      projects: platformProjects.ok ? platformProjects.projects : undefined,
    };
  }

  // Medido (sempre).
  const meas = await measuredAggregate(unit.id, sinceDays);
  const measTimelineSorted = [...meas.timeline.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const measToday = meas.timeline.get(isoDayUTC(new Date()))?.costUsd ?? 0;
  const measLast7 = sumWithinDays(
    measTimelineSorted,
    (t) => new Date(`${t.date}T00:00:00Z`),
    (t) => t.costUsd,
    7,
  );

  const measured: OpenAICard['measured'] = {
    sinceDays,
    totalCostUsd: meas.totalCostUsd,
    last7DaysCostUsd: measLast7,
    todayCostUsd: measToday,
    totalTokens: meas.totalTokens,
    numCalls: meas.numCalls,
    byModel: [...meas.byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd),
    timeline: measTimelineSorted,
  };

  // Comparativo agente vs total da OpenAI (% do que passa pela nossa plataforma).
  const agentShare: OpenAICard['agentShare'] = platform
    ? {
        percentOfRequests:
          platform.numRequests > 0 ? (measured.numCalls / platform.numRequests) * 100 : 0,
        percentOfCost:
          platform.totalCostUsd > 0 ? (measured.totalCostUsd / platform.totalCostUsd) * 100 : 0,
      }
    : null;

  // Orçamento — usa platform se disponível, senão measured.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const daysIntoMonth = Math.max(1, Math.ceil((Date.now() - monthStart.getTime()) / 86_400_000));
  const monthSpentPlatform = platform
    ? platform.timeline
        .filter((t) => new Date(`${t.date}T00:00:00Z`) >= monthStart)
        .reduce((s, t) => s + t.costUsd, 0)
    : null;
  const monthSpentMeasured = measured.timeline
    .filter((t) => new Date(`${t.date}T00:00:00Z`) >= monthStart)
    .reduce((s, t) => s + t.costUsd, 0);
  const spentUsd = monthSpentPlatform ?? monthSpentMeasured;
  const spentSource: 'platform' | 'measured' = monthSpentPlatform !== null ? 'platform' : 'measured';

  // Number(Decimal) pode dar NaN se o Decimal vier estranho — fallback pra 0.
  const monthlyUsdRaw = Number(unit.openaiMonthlyBudgetUsd);
  const monthlyUsd = Number.isFinite(monthlyUsdRaw) ? monthlyUsdRaw : 0;
  const safeSpentUsd = Number.isFinite(spentUsd) ? spentUsd : 0;
  const pctUsed = monthlyUsd > 0 ? (safeSpentUsd / monthlyUsd) * 100 : 0;
  const remainingUsd = Math.max(0, monthlyUsd - safeSpentUsd);
  const projectedMonthUsd = daysIntoMonth > 0 ? (safeSpentUsd / daysIntoMonth) * 30 : 0;

  let budgetAlert: 'ok' | 'warning' | 'danger' | 'over' = 'ok';
  if (pctUsed >= 100) budgetAlert = 'over';
  else if (pctUsed >= 90) budgetAlert = 'danger';
  else if (pctUsed >= 70) budgetAlert = 'warning';

  // Status agregado do card.
  const alerts: string[] = [];
  if (!unit.openaiApiKey) alerts.push('API key da OpenAI não configurada');
  else if (!ping.reachable) alerts.push(`API key não responde: ${ping.error ?? 'erro desconhecido'}`);
  if (!unit.openaiAdminKey)
    alerts.push('Sem Admin key — gastos reais da OpenAI não aparecem (mostrando só os medidos)');
  else if (!adminKeyUsable)
    alerts.push(`Admin key inválida: ${platformCosts.error ?? platformUsage.error ?? 'erro'}`);

  if (budgetAlert === 'over') {
    alerts.push(`🚨 Orçamento estourado: $${spentUsd.toFixed(2)} de $${monthlyUsd.toFixed(2)}`);
  } else if (budgetAlert === 'danger') {
    alerts.push(`⚠️ ${pctUsed.toFixed(0)}% do orçamento mensal já consumido`);
  } else if (budgetAlert === 'warning') {
    alerts.push(`Atenção: ${pctUsed.toFixed(0)}% do orçamento usado`);
  }
  if (projectedMonthUsd > monthlyUsd && spentUsd < monthlyUsd) {
    alerts.push(`📈 Projeção do mês: $${projectedMonthUsd.toFixed(2)} (acima do orçamento de $${monthlyUsd.toFixed(2)})`);
  }

  let status: CardStatus = 'ok';
  if (!unit.openaiApiKey) status = 'idle';
  else if (!ping.reachable || budgetAlert === 'over') status = 'danger';
  else if (budgetAlert === 'danger' || budgetAlert === 'warning' || (!unit.openaiAdminKey && unit.isActive)) status = 'warning';

  return {
    configured: !!unit.openaiApiKey,
    status,
    apiKey: {
      configured: !!unit.openaiApiKey,
      reachable: unit.openaiApiKey ? ping.reachable : null,
      modelCount: unit.openaiApiKey ? ping.modelCount : null,
      sampleModels: ping.sampleModels,
      error: ping.error,
    },
    adminKey: {
      configured: !!unit.openaiAdminKey,
      usable: unit.openaiAdminKey ? adminKeyUsable : null,
      error: !adminKeyUsable ? platformCosts.error ?? platformUsage.error : undefined,
    },
    assistantId: unit.openaiAssistantId,
    model: unit.openaiModel,
    platform,
    measured,
    agentShare,
    budget: {
      monthlyUsd,
      spentUsd: safeSpentUsd,
      spentSource,
      pctUsed,
      remainingUsd,
      daysIntoMonth,
      projectedMonthUsd,
      alert: budgetAlert,
    },
    alerts,
  };
}

async function buildKommoCard(unit: Unit): Promise<KommoCard> {
  const configured = !!unit.kommoSubdomain && !!unit.kommoAccessToken;
  if (!configured) {
    return {
      configured: false,
      status: 'idle',
      subdomain: unit.kommoSubdomain,
      reachable: null,
      account: null,
      alerts: ['Kommo não configurado para esta unidade'],
    };
  }

  try {
    // Não usamos o KommoClient porque ele lança em erro de domínio. Aqui
    // queremos um ping silencioso; falha vira "unreachable" sem 500 no painel.
    const url = `https://${unit.kommoSubdomain}.kommo.com/api/v4/account`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${unit.kommoAccessToken}` },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      const acc = res.data as { id?: number; name?: string; subdomain?: string };
      return {
        configured: true,
        status: 'ok',
        subdomain: unit.kommoSubdomain,
        reachable: true,
        account: { id: acc.id, name: acc.name, subdomain: acc.subdomain },
        alerts: [],
      };
    }
    return {
      configured: true,
      status: 'danger',
      subdomain: unit.kommoSubdomain,
      reachable: false,
      account: null,
      error: `HTTP ${res.status}`,
      alerts: [`Kommo não responde (HTTP ${res.status})`],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      configured: true,
      status: 'danger',
      subdomain: unit.kommoSubdomain,
      reachable: false,
      account: null,
      error: msg,
      alerts: [`Kommo inacessível: ${msg}`],
    };
  }
}

async function buildMetaCard(unit: Unit, host: string): Promise<MetaCard> {
  const hasToken = !!unit.metaAccessToken;
  const hasWaba = !!unit.metaWabaId;
  // "Configurado" agora = tem o que precisa pra puxar custo via Graph API.
  // Phone Number ID virou opcional (canal de envio/recepção é o Kommo).
  const configured = hasToken && hasWaba;
  const webhookUrl = `${host}/api/webhooks/${unit.slug}/meta`;
  const alerts: string[] = [];
  if (!hasToken) alerts.push('Access Token da Meta não configurado');
  if (hasToken && !hasWaba) alerts.push('WABA ID não configurado — custo da Meta não será sincronizado');

  // Mês corrente + janelas curtas via tabela snapshot.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const daysIntoMonth = Math.max(1, Math.ceil((Date.now() - monthStart.getTime()) / 86_400_000));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const last7 = new Date(today);
  last7.setUTCDate(last7.getUTCDate() - 6);

  let cost: MetaCard['cost'] = null;
  if (hasWaba) {
    const monthRows = await prisma.whatsappCostDaily.findMany({
      where: { unitId: unit.id, date: { gte: monthStart } },
      select: {
        date: true,
        pricingCategory: true,
        volume: true,
        costUsd: true,
        syncedAt: true,
      },
    });
    let monthSpentUsd = 0;
    let monthVolume = 0;
    let todayCostUsd = 0;
    let todayVolume = 0;
    let last7CostUsd = 0;
    let last7Volume = 0;
    let lastSync: Date | null = null;
    const byCategoryMap = new Map<string, { volume: number; costUsd: number }>();
    for (const r of monthRows) {
      const c = Number(r.costUsd);
      monthSpentUsd += c;
      monthVolume += r.volume;
      const day = r.date.getTime();
      if (day === today.getTime()) {
        todayCostUsd += c;
        todayVolume += r.volume;
      }
      if (r.date >= last7) {
        last7CostUsd += c;
        last7Volume += r.volume;
      }
      if (!lastSync || r.syncedAt > lastSync) lastSync = r.syncedAt;
      const cur = byCategoryMap.get(r.pricingCategory) ?? { volume: 0, costUsd: 0 };
      cur.volume += r.volume;
      cur.costUsd += c;
      byCategoryMap.set(r.pricingCategory, cur);
    }
    cost = {
      monthSpentUsd,
      monthVolume,
      todayCostUsd,
      todayVolume,
      last7DaysCostUsd: last7CostUsd,
      last7DaysVolume: last7Volume,
      byCategory: [...byCategoryMap.entries()]
        .map(([pricingCategory, v]) => ({ pricingCategory, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd),
      lastSyncedAt: lastSync ? lastSync.toISOString() : null,
    };
  }

  const monthlyUsd = Number(unit.metaMonthlyBudgetUsd ?? 0);
  const spentUsd = cost?.monthSpentUsd ?? 0;
  const pctUsed = monthlyUsd > 0 ? (spentUsd / monthlyUsd) * 100 : 0;
  const remainingUsd = Math.max(0, monthlyUsd - spentUsd);
  const projectedMonthUsd = daysIntoMonth > 0 ? (spentUsd / daysIntoMonth) * 30 : 0;
  let budgetAlert: MetaCard['budget']['alert'] = 'ok';
  if (pctUsed >= 100) budgetAlert = 'over';
  else if (pctUsed >= 90) budgetAlert = 'danger';
  else if (pctUsed >= 70) budgetAlert = 'warning';
  if (budgetAlert === 'over') {
    alerts.push(`🚨 Orçamento Meta estourado: $${spentUsd.toFixed(2)} de $${monthlyUsd.toFixed(2)}`);
  } else if (budgetAlert === 'danger') {
    alerts.push(`⚠️ Meta: ${pctUsed.toFixed(0)}% do orçamento mensal já consumido`);
  } else if (budgetAlert === 'warning') {
    alerts.push(`Atenção (Meta): ${pctUsed.toFixed(0)}% do orçamento usado`);
  }

  let status: CardStatus = 'idle';
  if (configured) {
    if (budgetAlert === 'over') status = 'danger';
    else if (budgetAlert === 'danger' || alerts.length > 0) status = 'warning';
    else status = 'ok';
  }

  return {
    configured,
    status,
    phoneNumberId: unit.metaPhoneNumberId,
    wabaId: unit.metaWabaId,
    hasAccessToken: hasToken,
    webhookUrl,
    cost,
    budget: {
      monthlyUsd,
      spentUsd,
      pctUsed,
      remainingUsd,
      daysIntoMonth,
      projectedMonthUsd,
      alert: budgetAlert,
    },
    alerts,
  };
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

export async function getIntegrations(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const sinceDays = Math.min(Number(req.query.days ?? 30), 90);
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  const host = `${req.protocol}://${req.get('host')}`;
  const [openai, kommo, meta] = await Promise.all([
    buildOpenAICard(unit, sinceDays),
    buildKommoCard(unit),
    buildMetaCard(unit, host),
  ]);

  // Agrega alerts por severidade pra exibir no badge global.
  const alerts: IntegrationsResponse['alerts'] = [];
  for (const a of openai.alerts) {
    const severity = a.startsWith('🚨') ? 'danger' : a.startsWith('⚠️') ? 'warning' : 'info';
    alerts.push({ severity, integration: 'openai', message: a });
  }
  for (const a of kommo.alerts) alerts.push({ severity: 'danger', integration: 'kommo', message: a });
  for (const a of meta.alerts) {
    const severity = a.startsWith('🚨') ? 'danger' : a.startsWith('⚠️') ? 'warning' : 'info';
    alerts.push({ severity, integration: 'meta', message: a });
  }

  const payload: IntegrationsResponse = {
    unit: { id: unit.id, slug: unit.slug, name: unit.name },
    generatedAt: new Date().toISOString(),
    openai,
    kommo,
    meta,
    alerts,
  };
  res.json(payload);
}

// ---------------------------------------------------------------------------
// Endpoint /alerts — badge no header. Corre por todas as Units ativas e
// retorna só o que precisa de atenção (warning/danger).
// ---------------------------------------------------------------------------

export async function getAlerts(_req: Request, res: Response): Promise<void> {
  const units = await prisma.unit.findMany({ where: { isActive: true } });
  const out: Array<{
    unitId: string;
    unitSlug: string;
    unitName: string;
    severity: 'warning' | 'danger';
    integration: string;
    message: string;
  }> = [];

  for (const unit of units) {
    // Pra performance, só inspecionamos OpenAI budget (a parte mais crítica
    // pra alerta) e Kommo ping. Ping cara; deixamos só pra unidades ativas.
    const openai = await buildOpenAICard(unit, 30);
    for (const a of openai.alerts) {
      const severity = a.startsWith('🚨') || openai.budget.alert === 'over' ? 'danger' : 'warning';
      if (a.startsWith('🚨') || a.startsWith('⚠️') || openai.status !== 'ok') {
        out.push({
          unitId: unit.id,
          unitSlug: unit.slug,
          unitName: unit.name,
          severity,
          integration: 'openai',
          message: a,
        });
      }
    }
    const kommo = await buildKommoCard(unit);
    if (kommo.configured && !kommo.reachable) {
      for (const a of kommo.alerts) {
        out.push({
          unitId: unit.id,
          unitSlug: unit.slug,
          unitName: unit.name,
          severity: 'danger',
          integration: 'kommo',
          message: a,
        });
      }
    }
  }

  // Respostas da IA paradas no campo "Resposta IA" sem o Salesbot entregar
  // (estado em memória do monitor, global — não por-Unit).
  for (const s of getStaleReplies()) {
    out.push({
      unitId: s.unitId,
      unitSlug: s.unitSlug,
      unitName: s.unitName,
      severity: 'danger',
      integration: 'kommo',
      message: `🐢 Resposta parada há ${s.ageMin}min sem entrega (lead ${s.leadId}) — Salesbot do Kommo travado. Empurre com /Agente DT.`,
    });
  }

  res.json({ alerts: out });
}

// ---------------------------------------------------------------------------
// Endpoint /delivery-monitor — painel "Saúde da Entrega" (Salesbot).
// Estado global em memória do monitor de "resposta parada": o que está parado
// agora + histórico recente de latências (PATCH no campo → entrega confirmada
// pelo webhook outgoing). Não é por-Unit, então gating de super admin.
// ---------------------------------------------------------------------------

export function getDeliveryMonitor(_req: Request, res: Response): void {
  res.json(getDeliveryStatus());
}
