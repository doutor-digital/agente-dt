import { prisma } from "../lib/prisma.js"

const SRC_SLUG = process.env.PARAUAPEBAS_SRC_SLUG || "doutor-hernia-serra"
const DST_SLUG = "doutor-hernia-parauapebas"
const DST_NAME = "Doutor Hérnia Parauapebas"
const KOMMO_SUBDOMAIN = "parauapebasdoutorhernia"

const PIPELINE_COMERCIAL = 13759323
const REPLY_FIELD_ID     = 2451012
const PAUSED_FIELD_ID    = 2451014
const WON_STATUS_IDS     = [ 142 ]
const ALLOWED_STATUS_IDS = [
    106159903,
    106159955,
    106159967,
    110478551,
    106449115,
    106449127,
]

const MOVE_STAGE_MAP: Record<number, { statusId: number, label: string }> = {
    110153704: { statusId: 106159955, label: "EM QUALIFICAÇÃO" },
    110153716: { statusId: 106449115, label: "EM NEGOCIAÇÃO"   },
    143:       { statusId: 143,       label: "PERDIDO"         },
}

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

type Passo = { kind?: string, params?: Record<string, unknown> }

function remapear(passos: Passo[]): { passos: Passo[], trocados: number } {
    let trocados = 0
    const saida = passos.map((p) => {
        if (p.kind !== "move_stage") return p
        const origem = Number(p.params?.statusId)
        const alvo = MOVE_STAGE_MAP[origem]
        if (!alvo) {
            console.warn(`   ! move_stage sem mapa para statusId ${origem} — deixado como está`)
            return p
        }
        trocados += 1
        return {
            ...p,
            params: {
                ...p.params,
                statusId: alvo.statusId,
                pipelineId: PIPELINE_COMERCIAL,
                statusLabel: alvo.label,
            },
        }
    })
    return { passos: saida, trocados }
}

async function main() {
    const token        = process.env.PARAUAPEBAS_KOMMO_TOKEN
    const geminiKey    = process.env.PARAUAPEBAS_GEMINI_KEY
    const anthropicKey = process.env.PARAUAPEBAS_ANTHROPIC_KEY
    if (!token) throw new Error("Faltou PARAUAPEBAS_KOMMO_TOKEN no ambiente.")
    if (!geminiKey && !anthropicKey) {
        throw new Error("Faltou a chave do provider: PARAUAPEBAS_ANTHROPIC_KEY ou PARAUAPEBAS_GEMINI_KEY.")
    }

    const credenciais = anthropicKey
        ? { llmProvider: "anthropic", anthropicApiKey: anthropicKey,
            anthropicModel: process.env.PARAUAPEBAS_CLAUDE_MODEL || "claude-sonnet-5" }
        : { llmProvider: "google", googleApiKey: geminiKey,
            googleModel: process.env.PARAUAPEBAS_GEMINI_MODEL || "gemini-2.5-flash" }

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
        personaGreeting: (src.personaGreeting ?? "").replace(/Serra|Imperatriz/gi, "Parauapebas") || src.personaGreeting,
        kommoReplyFieldId:  Number(process.env.PARAUAPEBAS_REPLY_FIELD_ID  || REPLY_FIELD_ID),
        kommoPausedFieldId: Number(process.env.PARAUAPEBAS_PAUSED_FIELD_ID || PAUSED_FIELD_ID),
        kommoWonStatusIds:     WON_STATUS_IDS,
        kommoAllowedStatusIds: ALLOWED_STATUS_IDS,
    })

    if (process.env.PARAUAPEBAS_SALESBOT_ID) clone.kommoSalesbotId = Number(process.env.PARAUAPEBAS_SALESBOT_ID)

    const existente = await prisma.unit.findUnique({
        where: { slug: DST_SLUG },
        include: { actions: true },
    })
    if (existente && existente.actions.length > 0) {
        console.log(`⛔ Parauapebas já existe com ${existente.actions.length} ações. Abortando pra não duplicar.`)
        return
    }

    const unidade = existente
        ? await prisma.unit.update({ where: { slug: DST_SLUG }, data: clone })
        : await prisma.unit.create({ data: clone as never })
    const modelo = unidade.llmProvider === "anthropic" ? unidade.anthropicModel : unidade.googleModel
    console.log(`✅ Unidade ${existente ? "atualizada" : "criada"}: ${unidade.id} (${unidade.slug}) — provider ${unidade.llmProvider}/${modelo}`)

    let totalTrocados = 0
    const acoes = src.actions.map((a) => {
        const { passos, trocados } = remapear((a.actions ?? []) as Passo[])
        totalTrocados += trocados
        return {
            unitId: unidade.id,
            conditionDescription: a.conditionDescription,
            actions: passos as never,
            actionKind: a.actionKind,
            actionParams: a.actionParams as never,
            notes: a.notes,
            enabled: a.enabled,
        }
    })
    if (acoes.length > 0) {
        await prisma.unitAction.createMany({ data: acoes })
    }
    console.log(`✅ ${acoes.length} ações replicadas — ${totalTrocados} move_stage reapontados para o funil ${PIPELINE_COMERCIAL}.`)

    console.log("\n⚠️  Lembretes lado Kommo (não é banco):")
    console.log("   - As tags usadas pelas ações add_tag precisam EXISTIR na conta (string exata).")
    console.log("   - Webhook (add_talk + add_message): https://agente-vps.doutordigitalconsultoria.com/api/webhooks/doutor-hernia-parauapebas/kommo")
    console.log("   - A entrega da resposta depende do Salesbot/Digital Pipeline lendo o campo 'Resposta da IA'.")
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
        console.error("❌ replicate-parauapebas falhou:", e)
        await prisma.$disconnect()
        process.exit(1)
    })
