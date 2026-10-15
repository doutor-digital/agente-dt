-- Placar das campanhas de disparo (Outubro Rosa 2026 em diante). Tabela nova e vazia: só o robô das 17h
-- (lib/campanha-worker.ts) e a coleta manual escrevem aqui.
CREATE TABLE "campanha_placar" (
    "id" TEXT NOT NULL,
    "campanha" TEXT NOT NULL,
    "unidade" TEXT NOT NULL,
    "dia" TEXT NOT NULL,
    "dados" JSONB NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campanha_placar_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campanha_placar_campanha_unidade_dia_key" ON "campanha_placar"("campanha", "unidade", "dia");
CREATE INDEX "campanha_placar_campanha_dia_idx" ON "campanha_placar"("campanha", "dia");
