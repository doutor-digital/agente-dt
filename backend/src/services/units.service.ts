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
// ---------------------------------------------------------------------------

export async function findUnitBySlug(slug: string): Promise<Unit | null> {
  return prisma.unit.findUnique({ where: { slug } });
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

  openaiApiKey?: string | null;
  openaiAdminKey?: string | null;
  openaiModel?: string;
  openaiAssistantId?: string | null;
  openaiTemperature?: number;
  openaiMaxTokens?: number;
  openaiMonthlyBudgetUsd?: number;

  metaPhoneNumberId?: string | null;
  metaAccessToken?: string | null;
  metaVerifyToken?: string | null;
  metaAppSecret?: string | null;

  systemPrompt?: string;
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
      openaiApiKey: input.openaiApiKey ?? null,
      openaiAdminKey: input.openaiAdminKey ?? null,
      openaiModel: input.openaiModel ?? 'gpt-4o-mini',
      openaiAssistantId: input.openaiAssistantId ?? null,
      openaiTemperature: input.openaiTemperature ?? 0,
      openaiMaxTokens: input.openaiMaxTokens ?? 1024,
      openaiMonthlyBudgetUsd: input.openaiMonthlyBudgetUsd ?? 50,
      metaPhoneNumberId: input.metaPhoneNumberId ?? null,
      metaAccessToken: input.metaAccessToken ?? null,
      metaVerifyToken: input.metaVerifyToken ?? null,
      metaAppSecret: input.metaAppSecret ?? null,
      systemPrompt: input.systemPrompt ?? '',
    },
  });
}

export async function updateUnit(id: string, input: Partial<UnitInput>): Promise<Unit> {
  return prisma.unit.update({
    where: { id },
    data: {
      ...(input.slug !== undefined && { slug: input.slug }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.kommoSubdomain !== undefined && { kommoSubdomain: input.kommoSubdomain }),
      ...(input.kommoAccessToken !== undefined && { kommoAccessToken: input.kommoAccessToken }),
      ...(input.kommoSalesbotId !== undefined && { kommoSalesbotId: input.kommoSalesbotId }),
      ...(input.kommoReplyFieldId !== undefined && { kommoReplyFieldId: input.kommoReplyFieldId }),
      ...(input.openaiApiKey !== undefined && { openaiApiKey: input.openaiApiKey }),
      ...(input.openaiAdminKey !== undefined && { openaiAdminKey: input.openaiAdminKey }),
      ...(input.openaiModel !== undefined && { openaiModel: input.openaiModel }),
      ...(input.openaiAssistantId !== undefined && { openaiAssistantId: input.openaiAssistantId }),
      ...(input.openaiTemperature !== undefined && { openaiTemperature: input.openaiTemperature }),
      ...(input.openaiMaxTokens !== undefined && { openaiMaxTokens: input.openaiMaxTokens }),
      ...(input.openaiMonthlyBudgetUsd !== undefined && { openaiMonthlyBudgetUsd: input.openaiMonthlyBudgetUsd }),
      ...(input.metaPhoneNumberId !== undefined && { metaPhoneNumberId: input.metaPhoneNumberId }),
      ...(input.metaAccessToken !== undefined && { metaAccessToken: input.metaAccessToken }),
      ...(input.metaVerifyToken !== undefined && { metaVerifyToken: input.metaVerifyToken }),
      ...(input.metaAppSecret !== undefined && { metaAppSecret: input.metaAppSecret }),
      ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
    },
  });
}

export async function deleteUnit(id: string): Promise<void> {
  await prisma.unit.delete({ where: { id } });
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
    openaiApiKey: mask(unit.openaiApiKey),
    openaiAdminKey: mask(unit.openaiAdminKey),
    metaAccessToken: mask(unit.metaAccessToken),
    metaAppSecret: mask(unit.metaAppSecret),
    metaVerifyToken: mask(unit.metaVerifyToken),
    _hasSecrets: {
      kommoAccessToken: !!unit.kommoAccessToken,
      openaiApiKey: !!unit.openaiApiKey,
      openaiAdminKey: !!unit.openaiAdminKey,
      metaAccessToken: !!unit.metaAccessToken,
      metaAppSecret: !!unit.metaAppSecret,
      metaVerifyToken: !!unit.metaVerifyToken,
    },
  };
}
