-- Régua do Chatwoot (worker chatwoot-regua): duas tabelas novas e vazias. Migration aditiva; nada existente é tocado.
-- CreateTable
CREATE TABLE IF NOT EXISTS "chatwoot_regua_visto" (
    "id" SERIAL NOT NULL,
    "caixa" INTEGER NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "campo" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "desde" TIMESTAMP(3) NOT NULL,
    "inicial" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "chatwoot_regua_visto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "chatwoot_regua_disparo" (
    "id" SERIAL NOT NULL,
    "caixa" INTEGER NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "regra" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "modo" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatwoot_regua_disparo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "chatwoot_regua_visto_caixa_conversation_id_campo_key" ON "chatwoot_regua_visto"("caixa", "conversation_id", "campo");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chatwoot_regua_disparo_caixa_criado_em_idx" ON "chatwoot_regua_disparo"("caixa", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "chatwoot_regua_disparo_conversation_id_regra_chave_key" ON "chatwoot_regua_disparo"("conversation_id", "regra", "chave");
