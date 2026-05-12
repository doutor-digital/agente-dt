-- ============================================================================
-- Multi-tenant + observabilidade rica.
--
-- Cria as tabelas:
--   - units                (tenant raiz com credenciais Kommo/OpenAI/Meta)
--   - conversations        (visão chat por lead)
--   - messages             (mensagens dentro da conversa)
--   - llm_calls            (toda chamada à LLM com tokens/custo/payloads)
--
-- Altera:
--   - execution_traces  + unit_id, channel
--   - agent_configs     + unit_id
--   - StepKind          + META_ACTION
--
-- IMPORTANTE: NÃO mexemos nas tabelas do PostgresSaver (`checkpoints`,
-- `checkpoint_writes`, `checkpoint_blobs`, `checkpoint_migrations`) — elas
-- pertencem ao @langchain/langgraph-checkpoint-postgres.
-- ============================================================================

-- AlterEnum: adiciona META_ACTION (idempotente — IF NOT EXISTS é Postgres 12+)
ALTER TYPE "StepKind" ADD VALUE IF NOT EXISTS 'META_ACTION';

-- AlterTable: agent_configs
ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "unit_id" TEXT;

-- AlterTable: execution_traces
ALTER TABLE "execution_traces" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'kommo';
ALTER TABLE "execution_traces" ADD COLUMN IF NOT EXISTS "unit_id" TEXT;

-- CreateTable: units
CREATE TABLE IF NOT EXISTS "units" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "kommo_subdomain" TEXT,
    "kommo_access_token" TEXT,
    "kommo_salesbot_id" INTEGER,
    "kommo_reply_field_id" INTEGER,
    "openai_api_key" TEXT,
    "openai_model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "openai_assistant_id" TEXT,
    "openai_temperature" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "openai_max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "meta_phone_number_id" TEXT,
    "meta_access_token" TEXT,
    "meta_verify_token" TEXT,
    "meta_app_secret" TEXT,
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable: conversations
CREATE TABLE IF NOT EXISTS "conversations" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "contact_name" TEXT,
    "phone" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'kommo',
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable: messages
CREATE TABLE IF NOT EXISTS "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "trace_id" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable: llm_calls
CREATE TABLE IF NOT EXISTS "llm_calls" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT,
    "trace_id" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "model" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL DEFAULT 'chat.completions',
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'success',
    "error_message" TEXT,
    "request_body" JSONB,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "units_slug_key" ON "units"("slug");

CREATE INDEX IF NOT EXISTS "conversations_unit_id_idx" ON "conversations"("unit_id");
CREATE INDEX IF NOT EXISTS "conversations_last_message_at_idx" ON "conversations"("last_message_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_unit_id_lead_id_key" ON "conversations"("unit_id", "lead_id");

CREATE INDEX IF NOT EXISTS "messages_conversation_id_idx" ON "messages"("conversation_id");
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages"("created_at" DESC);

CREATE INDEX IF NOT EXISTS "llm_calls_unit_id_idx" ON "llm_calls"("unit_id");
CREATE INDEX IF NOT EXISTS "llm_calls_trace_id_idx" ON "llm_calls"("trace_id");
CREATE INDEX IF NOT EXISTS "llm_calls_created_at_idx" ON "llm_calls"("created_at" DESC);

CREATE INDEX IF NOT EXISTS "agent_configs_unit_id_idx" ON "agent_configs"("unit_id");
CREATE INDEX IF NOT EXISTS "execution_traces_unit_id_idx" ON "execution_traces"("unit_id");

-- Foreign keys (criadas apenas se ainda não existirem)
DO $$ BEGIN
  ALTER TABLE "execution_traces" ADD CONSTRAINT "execution_traces_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_trace_id_fkey"
    FOREIGN KEY ("trace_id") REFERENCES "execution_traces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
