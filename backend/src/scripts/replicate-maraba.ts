import { prisma } from '../lib/prisma.js';

const SRC_SLUG = process.env.MARABA_SRC_SLUG || 'doutor-hernia-serra';
const DST_SLUG = 'doutor-hernia-maraba';
const DST_NAME = 'Doutor Hérnia Marabá';
const KOMMO_SUBDOMAIN = 'marabadoutorhernia';

const CIDADE_ORIGEM = /Serra/g;
const CIDADE_DESTINO = 'Marabá';

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

const REPLY_FIELD_ID = 2445976;
const PAUSED_FIELD_ID = 2445978;
const WON_STATUS_IDS = [142];
const ALLOWED_STATUS_IDS = [106397523, 106518971, 106518979, 107041719, 110475911, 107041731];

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
  const token = process.env.MARABA_KOMMO_TOKEN;
  const geminiKey = process.env.MARABA_GEMINI_KEY;
  const claudeKey = process.env.MARABA_ANTHROPIC_KEY;
  if (!token) throw new Error('Faltou MARABA_KOMMO_TOKEN no ambiente.');
  if (!geminiKey && !claudeKey)
    throw new Error('Faltou MARABA_GEMINI_KEY ou MARABA_ANTHROPIC_KEY no ambiente.');

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
    clone[k] = trocarCidade(v);
  }

  Object.assign(clone, {
    slug: DST_SLUG,
    name: DST_NAME,
    kommoSubdomain: KOMMO_SUBDOMAIN,
    kommoAccessToken: token,
    llmProvider: claudeKey ? 'anthropic' : 'google',
    ...(claudeKey
      ? { anthropicApiKey: claudeKey, anthropicModel: process.env.MARABA_CLAUDE_MODEL || 'claude-sonnet-5' }
      : { googleApiKey: geminiKey, googleModel: process.env.MARABA_GEMINI_MODEL || 'gemini-2.5-flash' }),
    kommoReplyFieldId: Number(process.env.MARABA_REPLY_FIELD_ID || REPLY_FIELD_ID),
    kommoPausedFieldId: Number(process.env.MARABA_PAUSED_FIELD_ID || PAUSED_FIELD_ID),
    kommoWonStatusIds: WON_STATUS_IDS,
    kommoAllowedStatusIds: ALLOWED_STATUS_IDS,
  });

  if (process.env.MARABA_SALESBOT_ID) clone.kommoSalesbotId = Number(process.env.MARABA_SALESBOT_ID);

  const existente = await prisma.unit.findUnique({
    where: { slug: DST_SLUG },
    include: { actions: true },
  });
  if (existente && existente.actions.length > 0) {
    console.log(`⛔ Marabá já existe com ${existente.actions.length} ações. Abortando pra não duplicar.`);
    return;
  }

  const maraba = existente
    ? await prisma.unit.update({ where: { slug: DST_SLUG }, data: clone })
    : await prisma.unit.create({ data: clone as never });
  const modelo = maraba.llmProvider === 'anthropic' ? maraba.anthropicModel : maraba.googleModel;
  console.log(`✅ Unidade Marabá ${existente ? 'atualizada' : 'criada'}: ${maraba.id} (${maraba.slug}) — provider ${maraba.llmProvider}/${modelo}`);

  const acoes = src.actions.map((a) => ({
    unitId: maraba.id,
    conditionDescription: trocarCidade(a.conditionDescription),
    actions: trocarCidade(a.actions) as never,
    actionKind: a.actionKind,
    actionParams: trocarCidade(a.actionParams) as never,
    notes: trocarCidade(a.notes),
    enabled: a.enabled,
  }));
  if (acoes.length > 0) {
    await prisma.unitAction.createMany({ data: acoes });
  }
  console.log(`✅ ${acoes.length} ações replicadas de ${SRC_SLUG}.`);

  console.log('\n⚠️  Lembretes lado Kommo (não é banco):');
  console.log('   - As tags usadas pelas ações add_tag precisam EXISTIR na conta Kommo de Marabá (string exata).');
  console.log('   - 142/143 de COMERCIAL e TRATAMENTO ainda precisam ser renomeados NA TELA (a API ignora).');
  console.log('   - Os 6 campos monetary (¤) só nascem pela TELA: o plano recusa monetary por API (HTTP 500).');
  console.log('   - Webhook Kommo add_message: https://agente-vps.doutordigitalconsultoria.com/api/webhooks/doutor-hernia-maraba/kommo');
  console.log('   - Desligar o sistema antigo da unidade antes de ligar a Sofia (senão resposta dupla).');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('❌ replicate-maraba falhou:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
