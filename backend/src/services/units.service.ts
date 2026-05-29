// ============================================================================
// units.service.ts — CRUD e resolução de Units (consultorias).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Toda execução é "dona" de uma Unit. Os webhooks recebem o `slug` na URL
// (`/api/webhooks/{slug}/...`) e este módulo resolve isso pra a Unit
// completa do banco.
//
// SEED IMPLÍCITO
// --------------
// Pra retrocompat com o webhook legado (`/api/webhooks/kommo`, sem slug),
// mantemos a noção de "default unit". Se ainda não existe nenhuma Unit no
// banco, criamos uma a partir do .env (institutotraumakommon). Idempotente.
// ============================================================================

import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/** Slug usado para a unidade default semeada do .env (retrocompat). */
const DEFAULT_SLUG = 'default';

// ---------------------------------------------------------------------------
// Resolve a Unit pelo slug. Lança erro se não existir.
//
// CACHE: os webhooks chamam essa função em cada turno (e em cada msg num
// payload com várias). TTL 30s — propagação rápida após updateUnit, que
// invalida explicitamente.
// ---------------------------------------------------------------------------

const UNIT_TTL_MS = 30_000;
const unitBySlugCache = new Map<string, { value: Unit | null; expiresAt: number }>();
const unitByIdCache = new Map<string, { value: Unit | null; expiresAt: number }>();

function invalidateUnitCacheFor(unit: Unit | null, fallbackId?: string): void {
  if (unit) {
    unitBySlugCache.delete(unit.slug);
    unitByIdCache.delete(unit.id);
  } else if (fallbackId) {
    unitByIdCache.delete(fallbackId);
  }
}

/** Limpa TODOS os caches de Unit — usado pelo endpoint admin "Limpar cache". */
export function clearAllUnitCache(): { slug: number; id: number } {
  const out = { slug: unitBySlugCache.size, id: unitByIdCache.size };
  unitBySlugCache.clear();
  unitByIdCache.clear();
  return out;
}

export async function findUnitBySlug(slug: string): Promise<Unit | null> {
  const cached = unitBySlugCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const unit = await prisma.unit.findUnique({ where: { slug } });
  unitBySlugCache.set(slug, { value: unit, expiresAt: Date.now() + UNIT_TTL_MS });
  if (unit) unitByIdCache.set(unit.id, { value: unit, expiresAt: Date.now() + UNIT_TTL_MS });
  return unit;
}

export async function findUnitBySlugOrThrow(slug: string): Promise<Unit> {
  const unit = await findUnitBySlug(slug);
  if (!unit) throw new Error(`Unit "${slug}" não encontrada`);
  return unit;
}

// ---------------------------------------------------------------------------
// Garante a unidade default — semeia a partir do .env se ainda não existir.
// É chamada no boot. Sem isso, os webhooks legados ficam sem unidade.
// ---------------------------------------------------------------------------

export async function ensureDefaultUnit(): Promise<Unit> {
  const existing = await prisma.unit.findUnique({ where: { slug: DEFAULT_SLUG } });
  if (existing) return existing;

  const seeded = await prisma.unit.create({
    data: {
      slug: DEFAULT_SLUG,
      name: env.KOMMO_SUBDOMAIN || 'Unidade Default',
      isActive: true,
      kommoSubdomain: env.KOMMO_SUBDOMAIN,
      kommoAccessToken: env.KOMMO_ACCESS_TOKEN,
      kommoSalesbotId: env.KOMMO_SALESBOT_ID ?? null,
      kommoReplyFieldId: env.KOMMO_REPLY_FIELD_ID ?? null,
      openaiApiKey: env.OPENAI_API_KEY,
      openaiModel: env.OPENAI_MODEL,
      systemPrompt: '',
    },
  });
  logger.info({ id: seeded.id, slug: seeded.slug }, 'Unit default semeada do .env');
  return seeded;
}

// ---------------------------------------------------------------------------
// CRUD usado pela API admin do dashboard.
// ---------------------------------------------------------------------------

export interface UnitInput {
  slug: string;
  name: string;
  isActive?: boolean;

  kommoSubdomain?: string | null;
  kommoAccessToken?: string | null;
  kommoSalesbotId?: number | null;
  kommoReplyFieldId?: number | null;
  kommoPausedFieldId?: number | null;
  kommoWonStatusIds?: number[];
  kommoBypassSalesbot?: boolean;
  kommoWidgetReplyEnabled?: boolean;
  kommoWidgetSecret?: string | null;
  kommoWidgetSalesbotId?: number | null;
  kommoSalesbotExecuteEnabled?: boolean;

  openaiApiKey?: string | null;
  openaiAdminKey?: string | null;
  openaiModel?: string;
  openaiAssistantId?: string | null;
  openaiTemperature?: number;
  openaiMaxTokens?: number;
  openaiTopP?: number;
  openaiFrequencyPenalty?: number;
  openaiPresencePenalty?: number;
  openaiMonthlyBudgetUsd?: number;

  metaPhoneNumberId?: string | null;
  metaAccessToken?: string | null;
  metaVerifyToken?: string | null;
  metaAppSecret?: string | null;
  metaWabaId?: string | null;
  metaMonthlyBudgetUsd?: number;

  systemPrompt?: string;

  /** Categoria/segmento da unidade (ex: "saude", "energia_solar"). */
  category?: string | null;

  // Wizard fields
  personaCompanyName?: string | null;
  personaTone?: string | null;
  personaGreeting?: string | null;
  personaResponseLength?: string;
  personaLanguage?: string;
  personaResponseDelaySec?: number;
  personaMinReplyGapSec?: number;
  personaEmojis?: string[];
  personaEmojiFrequency?: string;

  // Fontes (aba Fontes do painel da IA — 3 docs longos que entram no prompt).
  sourcePapel?: string | null;
  sourceProdutos?: string | null;
  sourceNegocio?: string | null;

  qualificationEnabled?: boolean;
  qualificationHotTag?: string;
  qualificationColdTag?: string;

  handoffEnabled?: boolean;
  handoffKeywords?: string[];

  pipelineIntents?: Record<string, number> | null;

  contactCollectionEnabled?: boolean;
  contactCollectionAfterTurns?: number;

  welcomeCouponEnabled?: boolean;
  welcomeCouponMessage?: string | null;

  businessHoursEnabled?: boolean;
  businessHoursStart?: number;
  businessHoursEnd?: number;
  businessHoursDays?: string[];
  businessHoursTimezone?: string;
  outOfHoursMessage?: string | null;

  followUpEnabled?: boolean;
  followUpAfterHours?: number;
  followUpMessage?: string | null;

  collectNameEnabled?: boolean;
  collectSourceEnabled?: boolean;
  collectSourceOptions?: string[];

  summaryCustomFieldId?: number | null;
  summaryCustomFieldName?: string | null;
}

export async function listUnits(): Promise<Unit[]> {
  return prisma.unit.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function createUnit(input: UnitInput): Promise<Unit> {
  return prisma.unit.create({
    data: {
      slug: input.slug,
      name: input.name,
      isActive: input.isActive ?? true,
      kommoSubdomain: input.kommoSubdomain ?? null,
      kommoAccessToken: input.kommoAccessToken ?? null,
      kommoSalesbotId: input.kommoSalesbotId ?? null,
      kommoReplyFieldId: input.kommoReplyFieldId ?? null,
      kommoPausedFieldId: input.kommoPausedFieldId ?? null,
      kommoWonStatusIds: input.kommoWonStatusIds ?? [],
      kommoWidgetReplyEnabled: input.kommoWidgetReplyEnabled ?? false,
      kommoWidgetSecret: input.kommoWidgetSecret ?? null,
      kommoWidgetSalesbotId: input.kommoWidgetSalesbotId ?? null,
      kommoSalesbotExecuteEnabled: input.kommoSalesbotExecuteEnabled ?? false,
      openaiApiKey: input.openaiApiKey ?? null,
      openaiAdminKey: input.openaiAdminKey ?? null,
      openaiModel: input.openaiModel ?? 'gpt-4o-mini',
      openaiAssistantId: input.openaiAssistantId ?? null,
      openaiTemperature: input.openaiTemperature ?? 0,
      openaiMaxTokens: input.openaiMaxTokens ?? 1024,
      openaiTopP: input.openaiTopP ?? 1,
      openaiFrequencyPenalty: input.openaiFrequencyPenalty ?? 0,
      openaiPresencePenalty: input.openaiPresencePenalty ?? 0,
      openaiMonthlyBudgetUsd: input.openaiMonthlyBudgetUsd ?? 50,
      metaPhoneNumberId: input.metaPhoneNumberId ?? null,
      metaAccessToken: input.metaAccessToken ?? null,
      metaVerifyToken: input.metaVerifyToken ?? null,
      metaAppSecret: input.metaAppSecret ?? null,
      metaWabaId: input.metaWabaId ?? null,
      metaMonthlyBudgetUsd: input.metaMonthlyBudgetUsd ?? 0,
      systemPrompt: input.systemPrompt ?? '',
      category: input.category ?? null,
      // Wizard
      personaCompanyName: input.personaCompanyName ?? null,
      personaTone: input.personaTone ?? null,
      personaGreeting: input.personaGreeting ?? null,
      personaResponseLength: input.personaResponseLength ?? 'normal',
      personaLanguage: input.personaLanguage ?? 'pt-BR',
      personaResponseDelaySec: input.personaResponseDelaySec ?? 0,
      personaMinReplyGapSec: input.personaMinReplyGapSec ?? 0,
      sourcePapel: input.sourcePapel ?? null,
      sourceProdutos: input.sourceProdutos ?? null,
      sourceNegocio: input.sourceNegocio ?? null,
      qualificationEnabled: input.qualificationEnabled ?? false,
      qualificationHotTag: input.qualificationHotTag ?? 'Quente',
      qualificationColdTag: input.qualificationColdTag ?? 'Frio',
      handoffEnabled: input.handoffEnabled ?? false,
      handoffKeywords: input.handoffKeywords ?? [],
      pipelineIntents: input.pipelineIntents ?? undefined,
      contactCollectionEnabled: input.contactCollectionEnabled ?? false,
      contactCollectionAfterTurns: input.contactCollectionAfterTurns ?? 3,
      welcomeCouponEnabled: input.welcomeCouponEnabled ?? false,
      welcomeCouponMessage: input.welcomeCouponMessage ?? null,
      businessHoursEnabled: input.businessHoursEnabled ?? false,
      businessHoursStart: input.businessHoursStart ?? 9,
      businessHoursEnd: input.businessHoursEnd ?? 18,
      businessHoursDays: input.businessHoursDays ?? ['mon', 'tue', 'wed', 'thu', 'fri'],
      businessHoursTimezone: input.businessHoursTimezone ?? 'America/Sao_Paulo',
      outOfHoursMessage: input.outOfHoursMessage ?? null,
      followUpEnabled: input.followUpEnabled ?? false,
      followUpAfterHours: input.followUpAfterHours ?? 24,
      followUpMessage: input.followUpMessage ?? null,
    },
  });
}

export async function updateUnit(id: string, input: Partial<UnitInput>): Promise<Unit> {
  const updated = await prisma.unit.update({
    where: { id },
    data: {
      ...(input.slug !== undefined && { slug: input.slug }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.kommoSubdomain !== undefined && { kommoSubdomain: input.kommoSubdomain }),
      ...(input.kommoAccessToken !== undefined && { kommoAccessToken: input.kommoAccessToken }),
      ...(input.kommoSalesbotId !== undefined && { kommoSalesbotId: input.kommoSalesbotId }),
      ...(input.kommoReplyFieldId !== undefined && { kommoReplyFieldId: input.kommoReplyFieldId }),
      ...(input.kommoPausedFieldId !== undefined && { kommoPausedFieldId: input.kommoPausedFieldId }),
      ...(input.kommoWonStatusIds !== undefined && { kommoWonStatusIds: input.kommoWonStatusIds }),
      ...(input.kommoBypassSalesbot !== undefined && { kommoBypassSalesbot: input.kommoBypassSalesbot }),
      ...(input.kommoWidgetReplyEnabled !== undefined && { kommoWidgetReplyEnabled: input.kommoWidgetReplyEnabled }),
      ...(input.kommoWidgetSecret !== undefined && { kommoWidgetSecret: input.kommoWidgetSecret }),
      ...(input.kommoWidgetSalesbotId !== undefined && { kommoWidgetSalesbotId: input.kommoWidgetSalesbotId }),
      ...(input.kommoSalesbotExecuteEnabled !== undefined && { kommoSalesbotExecuteEnabled: input.kommoSalesbotExecuteEnabled }),
      ...(input.openaiApiKey !== undefined && { openaiApiKey: input.openaiApiKey }),
      ...(input.openaiAdminKey !== undefined && { openaiAdminKey: input.openaiAdminKey }),
      ...(input.openaiModel !== undefined && { openaiModel: input.openaiModel }),
      ...(input.openaiAssistantId !== undefined && { openaiAssistantId: input.openaiAssistantId }),
      ...(input.openaiTemperature !== undefined && { openaiTemperature: input.openaiTemperature }),
      ...(input.openaiMaxTokens !== undefined && { openaiMaxTokens: input.openaiMaxTokens }),
      ...(input.openaiTopP !== undefined && { openaiTopP: input.openaiTopP }),
      ...(input.openaiFrequencyPenalty !== undefined && { openaiFrequencyPenalty: input.openaiFrequencyPenalty }),
      ...(input.openaiPresencePenalty !== undefined && { openaiPresencePenalty: input.openaiPresencePenalty }),
      ...(input.openaiMonthlyBudgetUsd !== undefined && { openaiMonthlyBudgetUsd: input.openaiMonthlyBudgetUsd }),
      ...(input.metaPhoneNumberId !== undefined && { metaPhoneNumberId: input.metaPhoneNumberId }),
      ...(input.metaAccessToken !== undefined && { metaAccessToken: input.metaAccessToken }),
      ...(input.metaVerifyToken !== undefined && { metaVerifyToken: input.metaVerifyToken }),
      ...(input.metaAppSecret !== undefined && { metaAppSecret: input.metaAppSecret }),
      ...(input.metaWabaId !== undefined && { metaWabaId: input.metaWabaId }),
      ...(input.metaMonthlyBudgetUsd !== undefined && { metaMonthlyBudgetUsd: input.metaMonthlyBudgetUsd }),
      ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.personaCompanyName !== undefined && { personaCompanyName: input.personaCompanyName }),
      ...(input.personaTone !== undefined && { personaTone: input.personaTone }),
      ...(input.personaGreeting !== undefined && { personaGreeting: input.personaGreeting }),
      ...(input.personaResponseLength !== undefined && { personaResponseLength: input.personaResponseLength }),
      ...(input.personaLanguage !== undefined && { personaLanguage: input.personaLanguage }),
      ...(input.personaResponseDelaySec !== undefined && { personaResponseDelaySec: input.personaResponseDelaySec }),
      ...(input.personaMinReplyGapSec !== undefined && { personaMinReplyGapSec: input.personaMinReplyGapSec }),
      ...(input.personaEmojis !== undefined && { personaEmojis: input.personaEmojis }),
      ...(input.personaEmojiFrequency !== undefined && { personaEmojiFrequency: input.personaEmojiFrequency }),
      ...(input.sourcePapel !== undefined && { sourcePapel: input.sourcePapel }),
      ...(input.sourceProdutos !== undefined && { sourceProdutos: input.sourceProdutos }),
      ...(input.sourceNegocio !== undefined && { sourceNegocio: input.sourceNegocio }),
      ...(input.qualificationEnabled !== undefined && { qualificationEnabled: input.qualificationEnabled }),
      ...(input.qualificationHotTag !== undefined && { qualificationHotTag: input.qualificationHotTag }),
      ...(input.qualificationColdTag !== undefined && { qualificationColdTag: input.qualificationColdTag }),
      ...(input.handoffEnabled !== undefined && { handoffEnabled: input.handoffEnabled }),
      ...(input.handoffKeywords !== undefined && { handoffKeywords: input.handoffKeywords }),
      ...(input.pipelineIntents !== undefined && { pipelineIntents: input.pipelineIntents ?? undefined }),
      ...(input.contactCollectionEnabled !== undefined && { contactCollectionEnabled: input.contactCollectionEnabled }),
      ...(input.contactCollectionAfterTurns !== undefined && { contactCollectionAfterTurns: input.contactCollectionAfterTurns }),
      ...(input.welcomeCouponEnabled !== undefined && { welcomeCouponEnabled: input.welcomeCouponEnabled }),
      ...(input.welcomeCouponMessage !== undefined && { welcomeCouponMessage: input.welcomeCouponMessage }),
      ...(input.businessHoursEnabled !== undefined && { businessHoursEnabled: input.businessHoursEnabled }),
      ...(input.businessHoursStart !== undefined && { businessHoursStart: input.businessHoursStart }),
      ...(input.businessHoursEnd !== undefined && { businessHoursEnd: input.businessHoursEnd }),
      ...(input.businessHoursDays !== undefined && { businessHoursDays: input.businessHoursDays }),
      ...(input.businessHoursTimezone !== undefined && { businessHoursTimezone: input.businessHoursTimezone }),
      ...(input.outOfHoursMessage !== undefined && { outOfHoursMessage: input.outOfHoursMessage }),
      ...(input.followUpEnabled !== undefined && { followUpEnabled: input.followUpEnabled }),
      ...(input.followUpAfterHours !== undefined && { followUpAfterHours: input.followUpAfterHours }),
      ...(input.followUpMessage !== undefined && { followUpMessage: input.followUpMessage }),
      ...(input.collectNameEnabled !== undefined && { collectNameEnabled: input.collectNameEnabled }),
      ...(input.collectSourceEnabled !== undefined && { collectSourceEnabled: input.collectSourceEnabled }),
      ...(input.collectSourceOptions !== undefined && { collectSourceOptions: input.collectSourceOptions }),
      ...(input.summaryCustomFieldId !== undefined && { summaryCustomFieldId: input.summaryCustomFieldId }),
      ...(input.summaryCustomFieldName !== undefined && { summaryCustomFieldName: input.summaryCustomFieldName }),
    },
  });
  invalidateUnitCacheFor(updated, id);
  return updated;
}

export async function deleteUnit(id: string): Promise<void> {
  await prisma.unit.delete({ where: { id } });
  invalidateUnitCacheFor(null, id);
}

// ---------------------------------------------------------------------------
// Mascarar campos sensíveis para resposta de API — nunca devolvemos secrets
// em texto puro pro front.
// ---------------------------------------------------------------------------

export function maskUnitSecrets<T extends Unit>(unit: T): T & { _hasSecrets: Record<string, boolean> } {
  const mask = (v: string | null) => (v ? `${v.slice(0, 6)}••••${v.slice(-4)}` : null);
  return {
    ...unit,
    kommoAccessToken: mask(unit.kommoAccessToken),
    kommoWidgetSecret: mask(unit.kommoWidgetSecret),
    openaiApiKey: mask(unit.openaiApiKey),
    openaiAdminKey: mask(unit.openaiAdminKey),
    metaAccessToken: mask(unit.metaAccessToken),
    metaAppSecret: mask(unit.metaAppSecret),
    metaVerifyToken: mask(unit.metaVerifyToken),
    _hasSecrets: {
      kommoAccessToken: !!unit.kommoAccessToken,
      kommoWidgetSecret: !!unit.kommoWidgetSecret,
      openaiApiKey: !!unit.openaiApiKey,
      openaiAdminKey: !!unit.openaiAdminKey,
      metaAccessToken: !!unit.metaAccessToken,
      metaAppSecret: !!unit.metaAppSecret,
      metaVerifyToken: !!unit.metaVerifyToken,
    },
  };
}
