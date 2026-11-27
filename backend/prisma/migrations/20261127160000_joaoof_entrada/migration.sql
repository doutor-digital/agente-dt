-- CreateTable
CREATE TABLE "joaoof_entrada" (
    "id" TEXT NOT NULL,
    "fonte" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "unidade_slug" TEXT,
    "autor_nome" TEXT NOT NULL DEFAULT '',
    "autor_chave" TEXT,
    "severidade" TEXT NOT NULL DEFAULT '',
    "texto" TEXT NOT NULL,
    "escrita_em" TIMESTAMP(3) NOT NULL,
    "processada_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "joaoof_entrada_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "joaoof_entrada_processada_em_escrita_em_idx" ON "joaoof_entrada"("processada_em", "escrita_em");

-- CreateIndex
CREATE UNIQUE INDEX "joaoof_entrada_fonte_ref_key" ON "joaoof_entrada"("fonte", "ref");

