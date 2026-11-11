-- Funil do Chatwoot: tarefas do cartão. Tabela nova e vazia. Migration aditiva.
-- CreateTable
CREATE TABLE IF NOT EXISTS "funil_tarefa" (
    "id" SERIAL NOT NULL,
    "conta" INTEGER NOT NULL,
    "conversa_id" INTEGER NOT NULL,
    "texto" TEXT NOT NULL,
    "vence_em" TIMESTAMP(3) NOT NULL,
    "responsavel" TEXT,
    "feita" BOOLEAN NOT NULL DEFAULT false,
    "feita_em" TIMESTAMP(3),
    "criado_por" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funil_tarefa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "funil_tarefa_conta_conversa_id_feita_idx" ON "funil_tarefa"("conta", "conversa_id", "feita");
