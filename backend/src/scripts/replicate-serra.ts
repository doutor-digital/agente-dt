import { prisma } from '../lib/prisma.js';

const SRC_SLUG = process.env.SERRA_SRC_SLUG || 'doutor-hernia-imperatriz';
const DST_SLUG = 'doutor-hernia-serra';
const DST_NAME = 'Doutor Hérnia Serra';
const KOMMO_SUBDOMAIN = 'drherniaserra';
const KOMMO_SALESBOT_ID = 86570;

const NAO_COPIAR = new Set<string>([
  'id', 'slug', 'name', 'createdAt', 'updatedAt',
  'kommoSubdomain', 'kommoAccessToken', 'kommoWidgetSecret', 'kommoSalesbotId',
  'kommoReplyFieldId', 'kommoPausedFieldId', 'kommoCommentReplyFieldId',
  'kommoWonStatusIds', 'kommoAllowedStatusIds', 'pipelineIntents',
  'kommoWidgetReplyEnabled', 'kommoSalesbotExecuteEnabled',
  'llmProvider', 'anthropicApiKey', 'openaiApiKey', 'openaiAdminKey',
  'openaiAssistantId', 'googleApiKey',
  'metaAccessToken', 'metaAppSecret', 'metaVerifyToken',
  'igAccessToken', 'igAppSecret', 'igVerifyToken',
  'fbAccessToken', 'fbAppSecret', 'fbVerifyToken',
  'spineEnabled', 'spineBaseUrl', 'spineToken',
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

  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (NAO_COPIAR.has(k)) continue;
    if (k === 'actions') continue;
    clone[k] = v;
  }

  Object.assign(clone, {
    slug: DST_SLUG,
    name: DST_NAME,
    kommoSubdomain: KOMMO_SUBDOMAIN,
    kommoAccessToken: token,
    kommoSalesbotId: KOMMO_SALESBOT_ID,
    llmProvider: 'google',
    googleApiKey: geminiKey,
    googleModel: process.env.SERRA_GEMINI_MODEL || 'gemini-2.5-flash',
    personaGreeting: (src.personaGreeting ?? '').replace(/Imperatriz/gi, 'Serra') || src.personaGreeting,
  });

  if (process.env.SERRA_REPLY_FIELD_ID) clone.kommoReplyFieldId = Number(process.env.SERRA_REPLY_FIELD_ID);
  if (process.env.SERRA_PAUSED_FIELD_ID) clone.kommoPausedFieldId = Number(process.env.SERRA_PAUSED_FIELD_ID);
  if (process.env.SERRA_WON_STATUS_IDS)
    clone.kommoWonStatusIds = process.env.SERRA_WON_STATUS_IDS.split(',').map((s) => Number(s.trim()));
  if (process.env.SERRA_ALLOWED_STATUS_IDS)
    clone.kommoAllowedStatusIds = process.env.SERRA_ALLOWED_STATUS_IDS.split(',').map((s) => Number(s.trim()));

  const existente = await prisma.unit.findUnique({
    where: { slug: DST_SLUG },
    include: { actions: true },
  });
  if (existente && existente.actions.length > 0) {
    console.log(`⛔ Serra já existe com ${existente.actions.length} ações. Abortando pra não duplicar.`);
    return;
  }

  const serra = existente
    ? await prisma.unit.update({ where: { slug: DST_SLUG }, data: clone })
    : await prisma.unit.create({ data: clone as never });
  console.log(`✅ Unidade Serra ${existente ? 'atualizada' : 'criada'}: ${serra.id} (${serra.slug}) — provider ${serra.llmProvider}/${serra.googleModel}`);

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
