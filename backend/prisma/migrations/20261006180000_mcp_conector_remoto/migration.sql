-- Conector remoto do claude.ai (MCP com OAuth 2.1). Quatro tabelas novas e vazias:
-- nada muda no comportamento de hoje. Códigos e tokens só como SHA-256; clientes sem segredo.

CREATE TABLE "mcp_oauth_clients" (
    "client_id" TEXT NOT NULL,
    "dados" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("client_id")
);

CREATE TABLE "mcp_oauth_codigos" (
    "codigo_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "escopos" TEXT[],
    "recurso" TEXT,
    "concessao_id" TEXT NOT NULL,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "usado_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_codigos_pkey" PRIMARY KEY ("codigo_hash")
);

CREATE TABLE "mcp_oauth_tokens" (
    "token_hash" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "concessao_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "escopos" TEXT[],
    "recurso" TEXT,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "revogado_em" TIMESTAMP(3),
    "substituido_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_tokens_pkey" PRIMARY KEY ("token_hash")
);

CREATE INDEX "mcp_oauth_codigos_expira_em_idx" ON "mcp_oauth_codigos"("expira_em");

CREATE INDEX "mcp_oauth_tokens_concessao_id_idx" ON "mcp_oauth_tokens"("concessao_id");
CREATE INDEX "mcp_oauth_tokens_expira_em_idx" ON "mcp_oauth_tokens"("expira_em");

CREATE TABLE "mcp_auditoria" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "ferramenta" TEXT NOT NULL,
    "argumentos" JSONB NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "duracao_ms" INTEGER NOT NULL,
    "erro" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_auditoria_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mcp_auditoria_created_at_idx" ON "mcp_auditoria"("created_at");
CREATE INDEX "mcp_auditoria_user_id_created_at_idx" ON "mcp_auditoria"("user_id", "created_at");
