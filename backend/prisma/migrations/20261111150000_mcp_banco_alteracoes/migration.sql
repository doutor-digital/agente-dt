-- Registro e backup das escritas no banco pelo conector do claude.ai (banco_confirmar_escrita). Tabela nova e vazia; migration aditiva.
-- CreateTable
CREATE TABLE "mcp_banco_alteracoes" (
    "id" TEXT NOT NULL,
    "banco" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "usuario_email" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "tabela" TEXT NOT NULL,
    "sql_texto" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "linhas" INTEGER NOT NULL,
    "chaves" JSONB NOT NULL,
    "antes" JSONB,
    "depois" JSONB,
    "desfaz_de" TEXT,
    "desfeito_em" TIMESTAMP(3),
    "desfeito_por" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_banco_alteracoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_banco_alteracoes_created_at_idx" ON "mcp_banco_alteracoes"("created_at");

-- CreateIndex
CREATE INDEX "mcp_banco_alteracoes_tabela_created_at_idx" ON "mcp_banco_alteracoes"("tabela", "created_at");
