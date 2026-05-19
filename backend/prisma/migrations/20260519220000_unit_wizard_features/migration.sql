-- ============================================================================
-- Adiciona os campos do Wizard de configuração da Unit.
--
-- Permite ao usuário leigo configurar 8 features (persona, auto-qualificação,
-- handoff, pipeline-by-intent, coleta de contato, cupom boas-vindas, horário
-- comercial, follow-up) sem mexer no system prompt diretamente.
-- O prompt-composer lê esses campos e gera o systemPrompt efetivo em runtime.
-- ============================================================================

-- PERSONA
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_company_name" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_tone" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_greeting" TEXT;

-- AUTO-QUALIFICAÇÃO
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "qualification_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "qualification_hot_tag" TEXT NOT NULL DEFAULT 'Quente';
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "qualification_cold_tag" TEXT NOT NULL DEFAULT 'Frio';

-- HANDOFF
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "handoff_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "handoff_keywords" TEXT[] NOT NULL DEFAULT '{}';

-- PIPELINE INTENTS
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "pipeline_intents" JSONB;

-- COLETA DE CONTATO
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "contact_collection_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "contact_collection_after_turns" INTEGER NOT NULL DEFAULT 3;

-- CUPOM BOAS-VINDAS
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "welcome_coupon_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "welcome_coupon_message" TEXT;

-- HORÁRIO COMERCIAL
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "business_hours_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "business_hours_start" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "business_hours_end" INTEGER NOT NULL DEFAULT 18;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "business_hours_days" TEXT[] NOT NULL DEFAULT ARRAY['mon','tue','wed','thu','fri'];
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "business_hours_timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "out_of_hours_message" TEXT;

-- FOLLOW-UP
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "follow_up_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "follow_up_after_hours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "follow_up_message" TEXT;
