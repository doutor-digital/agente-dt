-- ============================================================================
-- Adiciona paleta de emojis configurável pela Unit + frequência de uso.
-- A IA recebe a lista no prompt e usa livremente nas respostas.
-- ============================================================================

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_emojis" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_emoji_frequency" TEXT NOT NULL DEFAULT 'normal';
