-- ============================================================================
-- Adiciona Admin API key e orçamento mensal por Unit.
--
-- openai_admin_key (sk-admin-...) — usada pelos endpoints /v1/organization/*
--   (costs, usage, projects). A openai_api_key continua sendo a chave do
--   projeto, usada pelas chamadas de inferência.
--
-- openai_monthly_budget_usd — limite mensal em USD pra disparar alertas.
--   Default 50. Editável pelo painel.
-- ============================================================================

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "openai_admin_key" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "openai_monthly_budget_usd" DECIMAL(10,2) NOT NULL DEFAULT 50;
