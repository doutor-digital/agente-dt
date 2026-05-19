-- ============================================================================
-- Templates de mensagens (banco de respostas prontas) + flag de mensagens.
--
-- - message_templates: respostas prontas com palavras-chave de gatilho. O
--   prompt-composer inclui a lista no system prompt instruindo a IA a usar
--   quando detectar match.
-- - messages.flagged: operador marca respostas ruins. Composer puxa as
--   últimas N flaggadas como "examples to avoid" no prompt.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "message_templates" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger_keywords" TEXT[] NOT NULL DEFAULT '{}',
    "response" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_templates_unit_id_name_key"
  ON "message_templates"("unit_id", "name");

CREATE INDEX IF NOT EXISTS "message_templates_unit_id_idx"
  ON "message_templates"("unit_id");

ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Flag em mensagens
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "flagged" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS "messages_flagged_idx" ON "messages"("flagged");
