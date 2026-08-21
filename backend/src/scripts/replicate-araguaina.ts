import { prisma } from '../lib/prisma.js';

const SRC_SLUG = process.env.ARAGUAINA_SRC_SLUG || 'doutor-hernia-serra';
const DST_SLUG = 'doutor-hernia-araguaina';
const DST_NAME = 'Doutor Hérnia Araguaína';
const KOMMO_SUBDOMAIN = 'araguainadoutorhernia';

const CIDADE_ORIGEM = /Serra/g;
const CIDADE_DESTINO = 'Araguaína';

function trocarCidade<T>(valor: T): T {
  if (typeof valor === 'string') return valor.replace(CIDADE_ORIGEM, CIDADE_DESTINO) as unknown as T;
  if (Array.isArray(valor)) return valor.map(trocarCidade) as unknown as T;
  if (valor && typeof valor === 'object' && Object.getPrototypeOf(valor) === Object.prototype) {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor)) saida[k] = trocarCidade(v);
    return saida as T;
  }
  return valor;
}

const REPLY_FIELD_ID = 2449594;
const PAUSED_FIELD_ID = 2449726;
const WON_STATUS_IDS = [142];
const ALLOWED_STATUS_IDS = [106446563, 106518571, 106518579, 110440699, 106521059, 106521067];

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
  const token = process.env.ARAGUAINA_KOMMO_TOKEN;
  const geminiKey = process.env.ARAGUAINA_GEMINI_KEY;
  const claudeKey = process.env.ARAGUAINA_ANTHROPIC_KEY;
  if (!token) throw new Error('Faltou ARAGUAINA_KOMMO_TOKEN no ambiente.');
  if (!geminiKey && !claudeKey)
    throw new Error('Faltou ARAGUAINA_ANTHROPIC_KEY ou ARAGUAINA_GEMINI_KEY no ambiente.');

  const src = await prisma.unit.findUnique({ where: { slug: SRC_SLUG }, include: { actions: true } });
  if (!src) {
    const todas = await prisma.unit.findMany({ select: { slug: true } });
    throw new Error(`Unidade fonte "${SRC_SLUG}" não encontrada. Disponíveis: ${todas.map((u) => u.slug).join(', ')}`);
  }

  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (NAO_COPIAR.has(k)) continue;
    if (k === 'actions') continue;
    clone[k] = trocarCidade(v);
  }

  Object.assign(clone, {
    slug: DST_SLUG,
    name: DST_NAME,
    kommoSubdomain: KOMMO_SUBDOMAIN,
    kommoAccessToken: token,
    llmProvider: claudeKey ? 'anthropic' : 'google',
    ...(claudeKey
      ? { anthropicApiKey: claudeKey, anthropicModel: process.env.ARAGUAINA_CLAUDE_MODEL || 'claude-sonnet-5' }
      : { googleApiKey: geminiKey, googleModel: process.env.ARAGUAINA_GEMINI_MODEL || 'gemini-2.5-flash' }),
    kommoReplyFieldId: Number(process.env.ARAGUAINA_REPLY_FIELD_ID || REPLY_FIELD_ID),
    kommoPausedFieldId: Number(process.env.ARAGUAINA_PAUSED_FIELD_ID || PAUSED_FIELD_ID),
    kommoWonStatusIds: WON_STATUS_IDS,
    kommoAllowedStatusIds: ALLOWED_STATUS_IDS,
  });

  if (process.env.ARAGUAINA_SALESBOT_ID) clone.kommoSalesbotId = Number(process.env.ARAGUAINA_SALESBOT_ID);

  const existente = await prisma.unit.findUnique({ where: { slug: DST_SLUG }, include: { actions: true } });
  if (existente && existente.actions.length > 0) {
    console.log(`⛔ Porto já existe com ${existente.actions.length} ações. Abortando pra não duplicar.`);
    return;
  }

  const porto = existente
    ? await prisma.unit.update({ where: { slug: DST_SLUG }, data: clone })
    : await prisma.unit.create({ data: clone as never });
  const modelo = porto.llmProvider === 'anthropic' ? porto.anthropicModel : porto.googleModel;
  console.log(`✅ Unidade Porto ${existente ? 'atualizada' : 'criada'}: ${porto.id} (${porto.slug}) — provider ${porto.llmProvider}/${modelo}`);

  const acoes = src.actions.map((a) => ({
    unitId: porto.id,
    conditionDescription: trocarCidade(a.conditionDescription),
    actions: trocarCidade(a.actions) as never,
    actionKind: a.actionKind,
    actionParams: trocarCidade(a.actionParams) as never,
    notes: trocarCidade(a.notes),
    enabled: a.enabled,
  }));
  if (acoes.length > 0) await prisma.unitAction.createMany({ data: acoes });
  console.log(`✅ ${acoes.length} ações replicadas da Serra.`);

  console.log('\n⚠️  Lembretes lado Kommo (não é banco):');
  console.log('   - Webhook add_message -> https://api-vps.doutordigitalconsultoria.com/webhooks/kommo/doutor-hernia-araguaina');
  console.log('   - As tags das ações add_tag precisam EXISTIR no Kommo de Porto (string exata).');
  console.log('   - DESLIGAR a Cloudia + renomear 142/143 + criar 6 monetary na tela.');
  console.log('   - ROTACIONAR a chave Anthropic que vazou no chat.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('❌ replicate-porto falhou:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
