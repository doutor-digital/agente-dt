-- Disparo de campanha: rodadas seguidas com limite de taxa da Meta, por unidade (persistido). Tabela NOVA e vazia.
CREATE TABLE "disparo_limites" (
    "unit_id" TEXT NOT NULL,
    "seguidas" INTEGER NOT NULL DEFAULT 0,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disparo_limites_pkey" PRIMARY KEY ("unit_id")
);
