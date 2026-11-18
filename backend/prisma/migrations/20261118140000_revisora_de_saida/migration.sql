-- Revisora de saída da Sofia (modo seco): uma linha por resposta revisada. Tabela NOVA: nada existente muda.
CREATE TABLE "revisoes_de_saida" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "trace_id" TEXT,
    "conversation_id" TEXT,
    "modo" TEXT NOT NULL,
    "veredito" TEXT NOT NULL,
    "regras" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "violacoes" JSONB,
    "texto_enviado" TEXT NOT NULL,
    "provedor" TEXT,
    "modelo" TEXT,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "erro" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revisoes_de_saida_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "revisoes_de_saida_criado_em_idx" ON "revisoes_de_saida"("criado_em" DESC);
CREATE INDEX "revisoes_de_saida_unit_id_criado_em_idx" ON "revisoes_de_saida"("unit_id", "criado_em" DESC);
CREATE INDEX "revisoes_de_saida_lead_id_idx" ON "revisoes_de_saida"("lead_id");
