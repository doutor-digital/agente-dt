// ============================================================================
// scripts/replicate-serra.ts — cria a unidade "Doutor Hérnia Serra" replicando
// a persona + ações da Imperatriz (canônica), mas com:
//   - provider GOOGLE (Gemini 2.5-flash) em vez de Claude
//   - credenciais/IDs próprios da conta Kommo da Serra (drherniaserra)
//
// SEGURANÇA: segredos vêm de ENV, nunca hardcoded:
//   SERRA_KOMMO_TOKEN   — token de integração de longa duração da Serra (JWT)
//   SERRA_GEMINI_KEY    — chave da API do Gemini
//
// IDEMPOTENTE + GUARDA: se a Serra já existir com ações, ABORTA (não duplica).
//
// O QUE COPIA (conteúdo — o "cérebro"): persona*, source*, toggles (qualificação,
// handoff, follow-up), triagem, paleta de emoji, categoria, businessHours — via
// clone do row da fonte menos a lista de exclusão abaixo.
//
// O QUE NÃO COPIA (único da Serra): credenciais Kommo/OpenAI/Meta, IDs de etapa
// do funil e campos custom (DIFEREM por conta — configurar depois via painel ou
// preencher os ENV opcionais abaixo após ler os IDs reais da Serra no Kommo).
//
// Uso (na VPS, dentro do backend já deployado com o schema novo):
//   SERRA_KOMMO_TOKEN=... SERRA_GEMINI_KEY=... \
//     pnpm --filter agente-dt-backend exec tsx src/scripts/replicate-serra.ts
// ============================================================================

import { prisma } from '../lib/prisma.js';

const SRC_SLUG = process.env.SERRA_SRC_SLUG || 'doutor-hernia-imperatriz';
const DST_SLUG = 'doutor-hernia-serra';
const DST_NAME = 'Doutor Hérnia Serra';
const KOMMO_SUBDOMAIN = 'drherniaserra';
const KOMMO_SALESBOT_ID = 86570; // "AGENTE COMERCIAL"

// Campos que NÃO se copiam da fonte — únicos por unidade. Tudo o mais é conteúdo
// e vai junto. Ampla de propósito: melhor deixar de fora e configurar do que
// vazar credencial/ID errado da Imperatriz pra Serra.
const NAO_COPIAR = new Set<string>([
  'id', 'slug', 'name', 'createdAt', 'updatedAt',
  // Kommo — creds e IDs de etapa/campo (diferem por conta)
  'kommoSubdomain', 'kommoAccessToken', 'kommoWidgetSecret', 'kommoSalesbotId',
  'kommoReplyFieldId', 'kommoPausedFieldId', 'kommoCommentReplyFieldId',
  'kommoWonStatusIds', 'kommoAllowedStatusIds', 'pipelineIntents',
  'kommoWidgetReplyEnabled', 'kommoSalesbotExecuteEnabled',
  // Provider — Serra é google, definimos abaixo
  'llmProvider', 'anthropicApiKey', 'openaiApiKey', 'openaiAdminKey',
  'openaiAssistantId', 'googleApiKey',
  // Meta/IG/FB — creds próprias
  'metaAccessToken', 'metaAppSecret', 'metaVerifyToken',
  'igAccessToken', 'igAppSecret', 'igVerifyToken',
  'fbAccessToken', 'fbAppSecret', 'fbVerifyToken',
  // Franquia (agenda) — Serra configura quando tiver
  'spineEnabled', 'spineBaseUrl', 'spineToken',
  // Workers guardados — começam desligados na Serra (piloto)
  'reminderEnabled', 'reminderSalesbotId', 'reactivationEnabled',
]);

async function main() {
  const token = process.env.SERRA_KOMMO_TOKEN;
  const geminiKey = process.env.SERRA_GEMINI_KEY;
  if (!token) throw new Error('Faltou SERRA_KOMMO_TOKEN no ambiente.');
  if (!geminiKey) throw new Error('Faltou SERRA_GEMINI_KEY no ambiente.');

  const src = await prisma.unit.findUnique({
    where: { slug: SRC_SLUG },
    include: { actions: true },
  });
  if (!src) {
    const todas = await prisma.unit.findMany({ select: { slug: true } });
    throw new Error(
      `Unidade fonte "${SRC_SLUG}" não encontrada. Disponíveis: ${todas.map((u) => u.slug).join(', ')}`,
    );
  }

  // Clona o conteúdo: tudo do row da fonte menos a lista de exclusão.
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (NAO_COPIAR.has(k)) continue;
    if (k === 'actions') continue; // relação, copiada à parte
    clone[k] = v;
  }

  // Overrides da Serra.
  Object.assign(clone, {
    slug: DST_SLUG,
    name: DST_NAME,
    kommoSubdomain: KOMMO_SUBDOMAIN,
    kommoAccessToken: token,
    kommoSalesbotId: KOMMO_SALESBOT_ID,
    // IA no Gemini
    llmProvider: 'google',
    googleApiKey: geminiKey,
    googleModel: process.env.SERRA_GEMINI_MODEL || 'gemini-2.5-flash',
    // Saudação adaptada à cidade (se a fonte tiver — ajuste manual depois se quiser)
    personaGreeting: (src.personaGreeting ?? '').replace(/Imperatriz/gi, 'Serra') || src.personaGreeting,
  });

  // IDs de etapa/campo do Kommo da Serra — opcionais via ENV (preencher após ler
  // os IDs reais no Kommo da Serra). Sem eles, a unidade sobe e você configura
  // no painel; mover_etapa/agendamento só funcionam 100% depois de setados.
  if (process.env.SERRA_REPLY_FIELD_ID) clone.kommoReplyFieldId = Number(process.env.SERRA_REPLY_FIELD_ID);
  if (process.env.SERRA_PAUSED_FIELD_ID) clone.kommoPausedFieldId = Number(process.env.SERRA_PAUSED_FIELD_ID);
  if (process.env.SERRA_WON_STATUS_IDS)
    clone.kommoWonStatusIds = process.env.SERRA_WON_STATUS_IDS.split(',').map((s) => Number(s.trim()));
  if (process.env.SERRA_ALLOWED_STATUS_IDS)
    clone.kommoAllowedStatusIds = process.env.SERRA_ALLOWED_STATUS_IDS.split(',').map((s) => Number(s.trim()));

  // GUARDA: se a Serra já existe com ações, não mexe (evita duplicar).
  const existente = await prisma.unit.findUnique({
    where: { slug: DST_SLUG },
    include: { actions: true },
  });
  if (existente && existente.actions.length > 0) {
    console.log(`⛔ Serra já existe com ${existente.actions.length} ações. Abortando pra não duplicar.`);
    return;
  }

  // Cria (ou atualiza se existe sem ações) a unidade.
  const serra = existente
    ? await prisma.unit.update({ where: { slug: DST_SLUG }, data: clone })
    : await prisma.unit.create({ data: clone as never });
  console.log(`✅ Unidade Serra ${existente ? 'atualizada' : 'criada'}: ${serra.id} (${serra.slug}) — provider ${serra.llmProvider}/${serra.googleModel}`);

  // Copia as ações verbatim (add_tag/respond_with_intent — sem IDs de etapa).
  const acoes = src.actions.map((a) => ({
    unitId: serra.id,
    conditionDescription: a.conditionDescription,
    actions: a.actions as never,
    actionKind: a.actionKind,
    actionParams: a.actionParams as never,
    notes: a.notes,
    enabled: a.enabled,
  }));
  if (acoes.length > 0) {
    await prisma.unitAction.createMany({ data: acoes });
  }
  console.log(`✅ ${acoes.length} ações replicadas da Imperatriz.`);

  console.log('\n⚠️  Lembretes lado Kommo (não é banco):');
  console.log('   - As tags usadas pelas ações add_tag precisam EXISTIR na conta Kommo da Serra (string exata).');
  console.log('   - Configurar/confirmar: kommoReplyFieldId, kommoPausedFieldId, won/allowed status IDs e agendamento (IDs de campo diferem da Imperatriz).');
  console.log('   - Webhook Kommo: https://api-vps.doutordigitalconsultoria.com/webhooks/kommo/doutor-hernia-serra');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('❌ replicate-serra falhou:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
