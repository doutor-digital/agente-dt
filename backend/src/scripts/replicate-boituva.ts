import { prisma } from "../lib/prisma.js"

const SRC_SLUG = process.env.BOITUVA_SRC_SLUG || "doutor-hernia-serra"
const DST_SLUG = "doutor-hernia-boituva"
const DST_NAME = "Doutor Hérnia Boituva"
const KOMMO_SUBDOMAIN = "drherniaboituva"

const PIPELINE_COMERCIAL = 14329907
const REPLY_FIELD_ID     = 218468
const PAUSED_FIELD_ID    = 218470
const WON_STATUS_IDS     = [ 142 ]
const ALLOWED_STATUS_IDS = [
    110675111, // Etapa de entrada
    110675115, // EM QUALIFICAÇÃO
    110675119, // AGENDADO
    110675123, // COMPARECEU
    110675127, // EM NEGOCIAÇÃO
    110675131, // RETORNO PÓS-TRATAMENTO
]

const MOVE_STAGE_MAP: Record<number, { statusId: number, label: string }> = {
    110153704: { statusId: 110675115, label: "EM QUALIFICAÇÃO" },
    110153716: { statusId: 110675127, label: "EM NEGOCIAÇÃO"   },
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
    // dados de clínica NÃO herdam de outra unidade (bug de produção já visto):
    "clinicAddress", "pixKey", "pixHolder",
])

// Boituva ainda não mandou a FICHA DA UNIDADE — nada de preço/endereço/equipe
// herdado da Serra pode sobrar nos textos.
function limparTextos(texto: string): string {
    return texto
        .replace(/Doutor Hérnia Serra/g, "Doutor Hérnia Boituva")
        .replace(/unidade Serra/g, "unidade Boituva")
        .replace(/Imperatriz/g, "Boituva")
        .replace(/\bSerra\b/g, "Boituva")
        .replace(/R\$ ?350/g, "R$ [valor a confirmar — aguardando ficha da unidade]")
        .replace(/R\$ ?250/g, "R$ [valor à vista a confirmar — aguardando ficha da unidade]")
        .replace(/R\$ ?150/g, "R$ [valor à vista a confirmar — aguardando ficha da unidade]")
}

const DEMOGRAFIA_STUB =
    "PERFIL DA CIDADE — BOITUVA/SP\n" +
    "• (perfil demográfico a preencher — aguardando ficha da unidade)"

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
    const token        = process.env.BOITUVA_KOMMO_TOKEN
    const anthropicKey = process.env.BOITUVA_ANTHROPIC_KEY
    if (!token) throw new Error("Faltou BOITUVA_KOMMO_TOKEN no ambiente.")
    if (!anthropicKey) throw new Error("Faltou BOITUVA_ANTHROPIC_KEY no ambiente.")

    const credenciais = {
        llmProvider: "anthropic", anthropicApiKey: anthropicKey,
        anthropicModel: process.env.BOITUVA_CLAUDE_MODEL || "claude-sonnet-5",
    }

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

    for (const campo of [ "systemPrompt", "sourcePapel", "sourceProdutos", "sourceNegocio", "personaGreeting", "personaCompanyName" ]) {
        if (typeof clone[campo] === "string") clone[campo] = limparTextos(clone[campo] as string)
    }
    clone.sourceDemografia = DEMOGRAFIA_STUB

    Object.assign(clone, {
        slug: DST_SLUG,
        name: DST_NAME,
        kommoSubdomain: KOMMO_SUBDOMAIN,
        kommoAccessToken: token,
        ...credenciais,
        kommoReplyFieldId:  Number(process.env.BOITUVA_REPLY_FIELD_ID  || REPLY_FIELD_ID),
        kommoPausedFieldId: Number(process.env.BOITUVA_PAUSED_FIELD_ID || PAUSED_FIELD_ID),
        kommoWonStatusIds:     WON_STATUS_IDS,
        kommoAllowedStatusIds: ALLOWED_STATUS_IDS,
        // entrega DESLIGADA de propósito: sem WhatsApp ainda — kommoSalesbotId fica null
    })

    const existente = await prisma.unit.findUnique({
        where: { slug: DST_SLUG },
        include: { actions: true },
    })
    if (existente && existente.actions.length > 0) {
        console.log(`⛔ Boituva já existe com ${existente.actions.length} ações. Abortando pra não duplicar.`)
        return
    }

    const unidade = existente
        ? await prisma.unit.update({ where: { slug: DST_SLUG }, data: clone })
        : await prisma.unit.create({ data: clone as never })
    console.log(`✅ Unidade ${existente ? "atualizada" : "criada"}: ${unidade.id} (${unidade.slug}) — provider ${unidade.llmProvider}/${unidade.anthropicModel}`)

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
    console.log("   - Webhook (quando o WhatsApp chegar): https://agente-vps.doutordigitalconsultoria.com/api/webhooks/doutor-hernia-boituva/kommo")
    console.log("   - Entrega desligada de propósito (sem número): kommoSalesbotId=null, sem webhook add_message.")
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (e) => {
        console.error("❌ replicate-boituva falhou:", e)
        await prisma.$disconnect()
        process.exit(1)
    })
