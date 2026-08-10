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

import { Prisma, type Unit } from '@prisma/client';
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

export async function findUnitById(id: string): Promise<Unit | null> {
  const cached = unitByIdCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const unit = await prisma.unit.findUnique({ where: { id } });
  unitByIdCache.set(id, { value: unit, expiresAt: Date.now() + UNIT_TTL_MS });
  if (unit) unitBySlugCache.set(unit.slug, { value: unit, expiresAt: Date.now() + UNIT_TTL_MS });
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
  kommoAllowedStatusIds?: number[];
  kommoBypassSalesbot?: boolean;
  kommoWidgetReplyEnabled?: boolean;
  kommoWidgetSecret?: string | null;
  kommoWidgetSalesbotId?: number | null;
  kommoSalesbotExecuteEnabled?: boolean;

  // Provedor de LLM do chat: "openai" (default), "anthropic" ou "google".
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

  /** Modo prompt único — o systemPrompt vira o prompt inteiro (ver composer). */
  singlePromptMode?: boolean;

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

// ---------------------------------------------------------------------------
// QUAIS COLUNAS UM PATCH DA TELA PODE ESCREVER.
//
// Isto já foi uma lista escrita à mão — uma linha por campo, ~75 linhas de
// `...(input.x !== undefined && { x: input.x })`. O modo de falha dessa lista
// não é erro: é SILÊNCIO. Um campo novo passava pela validação, o endpoint
// devolvia 200 com a unidade inteira no corpo, e o valor simplesmente não era
// gravado. Foi exatamente o que aconteceu com os 35 campos de Spine, Instagram,
// Facebook e triagem: a tela salvava, dizia "salvo", e o banco continuava igual.
//
// Agora a lista vem do próprio schema do Prisma. Coluna que existe é gravável,
// exceto as que estão na negação abaixo. Não há mais como acrescentar um campo
// e esquecer de "ligar" a escrita.
// ---------------------------------------------------------------------------

/** Colunas que NUNCA vêm de um PATCH da tela — cada uma por um motivo. */
const NAO_EDITAVEL = new Set<string>([
  'id',
  'createdAt',
  'updatedAt',
  // Pausa de emergência tem rota própria (/spine/emergency-pause|resume).
  // Editável aqui viraria um segundo caminho para o mesmo controle de
  // incidente — e quem aperta o botão precisa de UM caminho, auditado.
  'spineAiPaused',
  'spinePausedAt',
  'spinePausedReason',
  // OAuth do Google: gravado pelo callback do fluxo de autorização. Digitar
  // um access token à mão produz credencial que expira sem refresh.
  'googleAccessToken',
  'googleRefreshToken',
  'googleTokenExpiresAt',
  'googleAuthorizedEmail',
  'googleAuthorizedAt',
]);

const CAMPOS_UNIT = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Unit')?.fields ?? [];

/** Nome da coluna -> é Json? (Json nulo precisa de DbNull, não de `null`). */
const COLUNAS_EDITAVEIS = new Map<string, boolean>(
  CAMPOS_UNIT.filter((f) => (f.kind === 'scalar' || f.kind === 'enum') && !NAO_EDITAVEL.has(f.name))
    .map((f) => [f.name, f.type === 'Json'] as const),
);

/**
 * Copia de `input` só o que é coluna gravável. O que sobrar é devolvido em
 * `ignorados` — o chamador registra, porque campo descartado em silêncio é a
 * falha que esta função existe pra impedir.
 */
function projetarColunas(input: object): {
  data: Record<string, unknown>;
  ignorados: string[];
} {
  const data: Record<string, unknown> = {};
  const ignorados: string[] = [];
  for (const [chave, valor] of Object.entries(input)) {
    if (valor === undefined) continue; // "não mexe neste campo"
    const ehJson = COLUNAS_EDITAVEIS.get(chave);
    if (ehJson === undefined) {
      ignorados.push(chave);
      continue;
    }
    // Json nulo: `null` é rejeitado pelo Prisma; DbNull é o NULL do banco.
    data[chave] = ehJson && valor === null ? Prisma.DbNull : valor;
  }
  return { data, ignorados };
}

/** Só para o guard de boot conferir a validação contra o banco. */
export function colunasEditaveisDaUnit(): string[] {
  return [...COLUNAS_EDITAVEIS.keys()];
}

/**
 * Padrões aplicados só na CRIAÇÃO, e só onde o formulário não mandou nada.
 * O que não está aqui cai no `@default` do schema — este objeto existe para os
 * casos em que o padrão de produto difere do padrão da coluna.
 */
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
    // Chega aqui só se o Zod deixou passar algo que não é coluna. Não é o
    // caso normal — e é justamente o que era invisível antes.
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
    _hasSecrets: {
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
