-- Tela «Robôs» do Chatwoot (14/11/2026): configuração por unidade e robô da régua (liga/desliga, tempo, modelo)
CREATE TABLE "chatwoot_regua_robo" (
    "id" TEXT NOT NULL,
    "unit_slug" TEXT NOT NULL,
    "regra" TEXT NOT NULL,
    "ligado" BOOLEAN NOT NULL DEFAULT true,
    "tempo_min" INTEGER,
    "modelos" JSONB NOT NULL DEFAULT '{}',
    "atualizado_por" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "chatwoot_regua_robo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chatwoot_regua_robo_unit_slug_regra_key" ON "chatwoot_regua_robo"("unit_slug", "regra");
