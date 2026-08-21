import { Prisma, type Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const DEFAULT_SLUG = 'default';

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

export async function findUnitById(id: string): Promise<Unit | null> {
  const cached = unitByIdCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const unit = await prisma.unit.findUnique({ where: { id } });
  unitByIdCache.set(id, { value: unit, expiresAt: Date.now() + UNIT_TTL_MS });
  if (unit) unitBySlugCache.set(unit.slug, { value: unit, expiresAt: Date.now() + UNIT_TTL_MS });
  return unit;
}

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
  kommoAllowedStatusIds?: number[];
  slaAlertStatusIds?: number[];
  kommoBypassSalesbot?: boolean;
  kommoWidgetReplyEnabled?: boolean;
  kommoWidgetSecret?: string | null;
  kommoWidgetSalesbotId?: number | null;
  kommoSalesbotExecuteEnabled?: boolean;

  llmProvider?: string;
  anthropicApiKey?: string | null;
  anthropicModel?: string;
  googleApiKey?: string | null;
  googleModel?: string;

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

  singlePromptMode?: boolean;

  category?: string | null;

  personaCompanyName?: string | null;
  personaTone?: string | null;
  personaGreeting?: string | null;
  personaResponseLength?: string;
  personaLanguage?: string;
  personaResponseDelaySec?: number;
  personaMinReplyGapSec?: number;
  personaEmojis?: string[];
  personaEmojiFrequency?: string;

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

const NAO_EDITAVEL = new Set<string>([
  'id',
  'createdAt',
  'updatedAt',
  'spineAiPaused',
  'spinePausedAt',
  'spinePausedReason',
  'googleAccessToken',
  'googleRefreshToken',
  'googleTokenExpiresAt',
  'googleAuthorizedEmail',
  'googleAuthorizedAt',
]);

const CAMPOS_UNIT = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Unit')?.fields ?? [];

const COLUNAS_EDITAVEIS = new Map<string, boolean>(
  CAMPOS_UNIT.filter((f) => (f.kind === 'scalar' || f.kind === 'enum') && !NAO_EDITAVEL.has(f.name))
    .map((f) => [f.name, f.type === 'Json'] as const),
);

function projetarColunas(input: object): {
  data: Record<string, unknown>;
  ignorados: string[];
} {
  const data: Record<string, unknown> = {};
  const ignorados: string[] = [];
  for (const [chave, valor] of Object.entries(input)) {
    if (valor === undefined) continue;
    const ehJson = COLUNAS_EDITAVEIS.get(chave);
    if (ehJson === undefined) {
      ignorados.push(chave);
      continue;
    }
    data[chave] = ehJson && valor === null ? Prisma.DbNull : valor;
  }
  return { data, ignorados };
}

export function colunasEditaveisDaUnit(): string[] {
  return [...COLUNAS_EDITAVEIS.keys()];
}

const PADROES_DE_CRIACAO: Record<string, unknown> = {
  isActive: true,
  kommoWonStatusIds: [],
  kommoAllowedStatusIds: [],
  kommoWidgetReplyEnabled: false,
  kommoSalesbotExecuteEnabled: false,
  llmProvider: 'openai',
  anthropicModel: 'claude-opus-4-8',
  openaiModel: 'gpt-4o-mini',
  openaiTemperature: 0,
  openaiMaxTokens: 1024,
  openaiTopP: 1,
  openaiFrequencyPenalty: 0,
  openaiPresencePenalty: 0,
  openaiMonthlyBudgetUsd: 50,
  metaMonthlyBudgetUsd: 0,
  systemPrompt: '',
  singlePromptMode: false,
  personaResponseLength: 'normal',
  personaLanguage: 'pt-BR',
  personaResponseDelaySec: 0,
  personaMinReplyGapSec: 0,
  qualificationEnabled: false,
  qualificationHotTag: 'Quente',
  qualificationColdTag: 'Frio',
  handoffEnabled: false,
  handoffKeywords: [],
  contactCollectionEnabled: false,
  contactCollectionAfterTurns: 3,
  welcomeCouponEnabled: false,
  businessHoursEnabled: false,
  businessHoursStart: 9,
  businessHoursEnd: 18,
  businessHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  businessHoursTimezone: 'America/Sao_Paulo',
  followUpEnabled: false,
  followUpAfterHours: 24,
};

export async function listUnits(): Promise<Unit[]> {
  return prisma.unit.findMany({ orderBy: { createdAt: 'asc' } });
}

export async function createUnit(input: UnitInput): Promise<Unit> {
  const { data, ignorados } = projetarColunas(input);
  if (ignorados.length > 0) {
    logger.warn({ slug: input.slug, ignorados }, 'createUnit: campos fora do schema, descartados');
  }
  const unit = await prisma.unit.create({
    data: { ...PADROES_DE_CRIACAO, ...data, slug: input.slug, name: input.name },
  });
  return unit;
}

export async function updateUnit(id: string, input: Partial<UnitInput>): Promise<Unit> {
  const { data, ignorados } = projetarColunas(input);
  if (ignorados.length > 0) {
    logger.warn({ id, ignorados }, 'updateUnit: campos fora do schema, descartados');
  }
  const updated = await prisma.unit.update({ where: { id }, data });
  invalidateUnitCacheFor(updated, id);
  return updated;
}

export async function deleteUnit(id: string): Promise<void> {
  await prisma.unit.delete({ where: { id } });
  invalidateUnitCacheFor(null, id);
}

export function maskUnitSecrets<T extends Unit>(unit: T): T & { _hasSecrets: Record<string, boolean> } {
  const mask = (v: string | null) => (v ? `${v.slice(0, 6)}••••${v.slice(-4)}` : null);
  return {
    ...unit,
    kommoAccessToken: mask(unit.kommoAccessToken),
    kommoWidgetSecret: mask(unit.kommoWidgetSecret),
    anthropicApiKey: mask(unit.anthropicApiKey),
    googleApiKey: mask(unit.googleApiKey),
    openaiApiKey: mask(unit.openaiApiKey),
    openaiAdminKey: mask(unit.openaiAdminKey),
    metaAccessToken: mask(unit.metaAccessToken),
    metaAppSecret: mask(unit.metaAppSecret),
    metaVerifyToken: mask(unit.metaVerifyToken),
    igAccessToken: mask(unit.igAccessToken),
    igAppSecret: mask(unit.igAppSecret),
    igVerifyToken: mask(unit.igVerifyToken),
    fbAccessToken: mask(unit.fbAccessToken),
    fbAppSecret: mask(unit.fbAppSecret),
    fbVerifyToken: mask(unit.fbVerifyToken),
    spineToken: mask(unit.spineToken),
    googleAccessToken: mask(unit.googleAccessToken),
    googleRefreshToken: mask(unit.googleRefreshToken),
    _hasSecrets: {
      googleAccessToken: !!unit.googleAccessToken,
      googleRefreshToken: !!unit.googleRefreshToken,
      kommoAccessToken: !!unit.kommoAccessToken,
      kommoWidgetSecret: !!unit.kommoWidgetSecret,
      anthropicApiKey: !!unit.anthropicApiKey,
      googleApiKey: !!unit.googleApiKey,
      openaiApiKey: !!unit.openaiApiKey,
      openaiAdminKey: !!unit.openaiAdminKey,
      metaAccessToken: !!unit.metaAccessToken,
      metaAppSecret: !!unit.metaAppSecret,
      metaVerifyToken: !!unit.metaVerifyToken,
      igAccessToken: !!unit.igAccessToken,
      igAppSecret: !!unit.igAppSecret,
      igVerifyToken: !!unit.igVerifyToken,
      fbAccessToken: !!unit.fbAccessToken,
      fbAppSecret: !!unit.fbAppSecret,
      fbVerifyToken: !!unit.fbVerifyToken,
      spineToken: !!unit.spineToken,
    },
  };
}
