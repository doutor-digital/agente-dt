import { prisma } from "../lib/prisma.js"

const SRC_SLUG = process.env.BALSAS_SRC_SLUG || "doutor-hernia-serra"
const DST_SLUG = "doutor-hernia-balsas"
const DST_NAME = "Doutor Hérnia Balsas"
const KOMMO_SUBDOMAIN = "doutorherniabalsas"

const REPLY_FIELD_ID   = 2450406
const PAUSED_FIELD_ID  = 2450408
const WON_STATUS_IDS   = [ 142 ]
const ALLOWED_STATUS_IDS = [
    106820083,
    106820287,
    106820579,
    110474759,
    106820587,
    110474763,
]

const NAO_COPIAR = new Set<string>([
    "id", "slug", "name", "createdAt", "updatedAt",
    "kommoSubdomain", "kommoAccessToken", "kommoWidgetSecret", "kommoSalesbotId",
    "kommoReplyFieldId", "kommoPausedFieldId", "kommoCommentReplyFieldId",
    // Id de campo é POR CONTA no Kommo. Copiar estes três já quebrou produção:
    // o resumo do handoff foi parar no campo da Serra em 15 unidades, e os
    // campos de resposta de Instagram/Facebook apontaram pra um id inexistente
    // em 19. Falha silenciosa: o Kommo devolve 404 e o atendimento segue.
    "summaryCustomFieldId", "igReplyFieldId", "fbReplyFieldId",
    "kommoWonStatusIds", "kommoAllowedStatusIds", "pipelineIntents",
    "kommoWidgetReplyEnabled", "kommoSalesbotExecuteEnabled",
    "llmProvider", "anthropicApiKey", "openaiApiKey", "openaiAdminKey",
    "openaiAssistantId", "googleApiKey",
    "metaAccessToken", "metaAppSecret", "metaVerifyToken",
    "igAccessToken", "igAppSecret", "igVerifyToken",
    "fbAccessToken", "fbAppSecret", "fbVerifyToken",
    "spineEnabled", "spineBaseUrl", "spineToken",
    "reminderEnabled", "reminderSalesbotId", "reactivationEnabled",
])

function idsFromEnv(nome: string, padrao: number[]): number[] {
    const bruto = process.env[nome]
    if (!bruto) return padrao
    return bruto.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
}

async function main() {
    const token        = process.env.BALSAS_KOMMO_TOKEN
    const geminiKey    = process.env.BALSAS_GEMINI_KEY
    const anthropicKey = process.env.BALSAS_ANTHROPIC_KEY
    if (!token) throw new Error("Faltou BALSAS_KOMMO_TOKEN no ambiente.")
    if (!geminiKey && !anthropicKey) {
        throw new Error("Faltou a chave do provider: BALSAS_GEMINI_KEY ou BALSAS_ANTHROPIC_KEY.")
    }

    const credenciais = anthropicKey
        ? { llmProvider: "anthropic", anthropicApiKey: anthropicKey,
            anthropicModel: process.env.BALSAS_CLAUDE_MODEL || "claude-sonnet-5" }
        : { llmProvider: "google", googleApiKey: geminiKey,
            googleModel: process.env.BALSAS_GEMINI_MODEL || "gemini-2.5-flash" }

    const src = await prisma.unit.findUnique({
        where: { slug: SRC_SLUG },
        include: { actions: true },
    })
    if (!src) {
        const todas = await prisma.unit.findMany({ select: { slug: true } })
        throw new Error(
            `Unidade fonte "${SRC_SLUG}" não encontrada. Disponíveis: ${todas.map((u) => u.slug).join(", ")}`,
        )
    }

    const clone: Record<string, unknown> = {}
    for (const [ k, v ] of Object.entries(src)) {
        if (NAO_COPIAR.has(k)) continue
        if (k === "actions") continue
        clone[k] = v
    }

    Object.assign(clone, {
        slug: DST_SLUG,
        name: DST_NAME,
        kommoSubdomain: KOMMO_SUBDOMAIN,
        kommoAccessToken: token,
        ...credenciais,
        personaGreeting: (src.personaGreeting ?? "").replace(/Imperatriz/gi, "Balsas") || src.personaGreeting,
        kommoReplyFieldId:  Number(process.env.BALSAS_REPLY_FIELD_ID  || REPLY_FIELD_ID),
        kommoPausedFieldId: Number(process.env.BALSAS_PAUSED_FIELD_ID || PAUSED_FIELD_ID),
        kommoWonStatusIds:     idsFromEnv("BALSAS_WON_STATUS_IDS", WON_STATUS_IDS),
        kommoAllowedStatusIds: idsFromEnv("BALSAS_ALLOWED_STATUS_IDS", ALLOWED_STATUS_IDS),
    })

    if (process.env.BALSAS_SALESBOT_ID) clone.kommoSalesbotId = Number(process.env.BALSAS_SALESBOT_ID)

    const existente = await prisma.unit.findUnique({
        where: { slug: DST_SLUG },
        include: { actions: true },
    })
    if (existente && existente.actions.length > 0) {
        console.log(`⛔ Balsas já existe com ${existente.actions.length} ações. Abortando pra não duplicar.`)
        return
    }

    const balsas = existente
        ? await prisma.unit.update({ where: { slug: DST_SLUG }, data: clone })
        : await prisma.unit.create({ data: clone as never })
    const modelo = balsas.llmProvider === "anthropic" ? balsas.anthropicModel : balsas.googleModel
    console.log(`✅ Unidade Balsas ${existente ? "atualizada" : "criada"}: ${balsas.id} (${balsas.slug}) — provider ${balsas.llmProvider}/${modelo}`)

    const acoes = src.actions.map((a) => ({
        unitId: balsas.id,
        conditionDescription: a.conditionDescription,
        actions: a.actions as never,
        actionKind: a.actionKind,
        actionParams: a.actionParams as never,
        notes: a.notes,
        enabled: a.enabled,
    }))
    if (acoes.length > 0) {
        await prisma.unitAction.createMany({ data: acoes })
    }
    console.log(`✅ ${acoes.length} ações replicadas da Imperatriz.`)

    console.log("\n⚠️  Lembretes lado Kommo (não é banco):")
    console.log("   - As tags usadas pelas ações add_tag precisam EXISTIR na conta Kommo de Balsas (string exata).")
    console.log("   - BALSAS_SALESBOT_ID não é lido por API: pegar na tela do Kommo e setar via ENV.")
    console.log("   - Webhook Kommo (add_talk + add_message): https://agente-vps.doutordigitalconsultoria.com/api/webhooks/doutor-hernia-balsas/kommo")
    console.log("   - DESLIGAR o n8n antigo (webhook status_lead) antes do piloto, pra não ter resposta dupla.")
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
        console.error("❌ replicate-balsas falhou:", e)
        await prisma.$disconnect()
        process.exit(1)
    })
