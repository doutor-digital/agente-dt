-- Central do João (fase 1): pausa do agente de chamados por pessoa (extensão do Chrome). Tabela nova e vazia; sem linha = não pausado. Migration aditiva.
-- CreateTable
CREATE TABLE IF NOT EXISTS "suporte_pausa_pessoa" (
    "chave" TEXT NOT NULL,
    "final" TEXT NOT NULL,
    "nome" TEXT,
    "pausado_por" TEXT NOT NULL,
    "pausado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ignoradas" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "suporte_pausa_pessoa_pkey" PRIMARY KEY ("chave")
);
