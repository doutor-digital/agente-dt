-- Cria a tabela que o modelo GlobalAction sempre teve — e a migration não.
--
-- O modelo entrou no schema.prisma sem migration correspondente, então em
-- produção a tabela nunca existiu. Todo turno do agente chamava
-- listEnabledGlobalActions, tomava P2021 ("table does not exist") e seguia
-- pelo caminho de fail-soft.
--
-- O fail-soft é o que tornou isso invisível: nada quebrava, só que NENHUMA
-- regra global era aplicada — a tela existia, dava pra cadastrar regra, e a
-- regra não valia para nenhum agente. Silêncio é pior que erro aqui.
--
-- IF NOT EXISTS porque ambientes criados via `db push` já podem ter a tabela.
CREATE TABLE IF NOT EXISTS "global_actions" (
    "id" TEXT NOT NULL,
    "condition_description" TEXT NOT NULL,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "global_actions_enabled_priority_idx"
  ON "global_actions"("enabled", "priority");
