-- Disparo pela tela «Disparos» do CRM (Chatwoot): uma ORIGEM nova no motor de disparo que já existe (Kommo).
-- Migration ADITIVA (expand): colunas novas com padrão, nenhuma existente é tocada. Toda onda que já existe vira origem 'kommo'.
ALTER TABLE "disparo_ondas" ADD COLUMN IF NOT EXISTS "origem" TEXT NOT NULL DEFAULT 'kommo';
ALTER TABLE "disparo_ondas" ADD COLUMN IF NOT EXISTS "conta_chatwoot" INTEGER;
ALTER TABLE "disparo_ondas" ADD COLUMN IF NOT EXISTS "caixa_chatwoot" INTEGER;
ALTER TABLE "disparo_ondas" ADD COLUMN IF NOT EXISTS "filtro" JSONB;

ALTER TABLE "disparo_destinatarios" ADD COLUMN IF NOT EXISTS "conversa_chatwoot" INTEGER;
ALTER TABLE "disparo_destinatarios" ADD COLUMN IF NOT EXISTS "contato_chatwoot" INTEGER;

CREATE INDEX IF NOT EXISTS "disparo_ondas_origem_estado_idx" ON "disparo_ondas"("origem", "estado");

-- Ajuste por unidade (aprovação pela gerente da clínica; teto do número). Sem linha = tudo desligado/de fábrica.
CREATE TABLE IF NOT EXISTS "chatwoot_disparo_ajustes" (
    "unit_id" TEXT NOT NULL,
    "gerente_aprova" BOOLEAN NOT NULL DEFAULT false,
    "tier_do_numero" TEXT,
    "atualizado_por" TEXT,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatwoot_disparo_ajustes_pkey" PRIMARY KEY ("unit_id")
);
