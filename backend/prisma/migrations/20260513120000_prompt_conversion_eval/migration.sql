-- ============================================================================
-- Captura de conversão + avaliação qualitativa (LLM-as-judge).
--
-- 1) units.kommo_won_status_ids — array de status_ids do Kommo que contam
--    como "Ganho". Quando o webhook leads.status traz um id desta lista,
--    marcamos a Conversation como convertida.
--
-- 2) conversations.converted_at / converted_status_id — timestamp + etapa
--    final do funil que disparou a conversão. converted_at NULL = não
--    convertido ainda.
--
-- 3) conversation_evaluations — registro do juiz LLM. UMA por Conversation
--    (unique). prompt_hash = sha256 do system prompt usado no momento da
--    conversão, é a chave de agrupamento do painel "Prompts".
-- ============================================================================

-- 1) Won status ids por Unit
ALTER TABLE "units"
  ADD COLUMN IF NOT EXISTS "kommo_won_status_ids" INTEGER[] NOT NULL DEFAULT '{}';

-- 2) Conversion marker na Conversation
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "converted_at"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "converted_status_id" INTEGER;

CREATE INDEX IF NOT EXISTS "conversations_converted_at_idx"
  ON "conversations" ("converted_at" DESC);

-- 3) ConversationEvaluation
CREATE TABLE IF NOT EXISTS "conversation_evaluations" (
  "id"               TEXT NOT NULL,
  "conversation_id"  TEXT NOT NULL,
  "unit_id"          TEXT NOT NULL,
  "prompt_hash"      TEXT NOT NULL,
  "prompt_snapshot"  TEXT NOT NULL,
  "model"            TEXT NOT NULL,
  "scores"           JSONB NOT NULL,
  "overall_score"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "verdict"          TEXT NOT NULL,
  "cost_usd"         DECIMAL(12,6) NOT NULL DEFAULT 0,
  "latency_ms"       INTEGER NOT NULL DEFAULT 0,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_evaluations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_evaluations_conversation_id_key"
  ON "conversation_evaluations" ("conversation_id");

CREATE INDEX IF NOT EXISTS "conversation_evaluations_unit_id_idx"
  ON "conversation_evaluations" ("unit_id");

CREATE INDEX IF NOT EXISTS "conversation_evaluations_prompt_hash_idx"
  ON "conversation_evaluations" ("prompt_hash");

CREATE INDEX IF NOT EXISTS "conversation_evaluations_created_at_idx"
  ON "conversation_evaluations" ("created_at" DESC);

ALTER TABLE "conversation_evaluations"
  ADD CONSTRAINT "conversation_evaluations_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
