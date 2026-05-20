-- ============================================================================
-- Cria a tabela unit_actions — regras "quando → faça" por Unit.
--
-- Cada regra é uma instrução semântica que vai pro prompt da IA. Substitui
-- (no longo prazo) o uso de campos soltos como handoff_keywords e
-- pipeline_intents — esses continuam funcionando, mas a UI passa a oferecer
-- um construtor visual de regras por cima de tudo isso.
--
-- action_kind:
--   - "add_tag"                     : aplica uma ou mais tags
--   - "transfer_with_permission"    : pede confirmação antes de transferir
--   - "transfer_without_permission" : transfere imediatamente
--
-- action_params (JSONB) varia por kind:
--   - add_tag: { "tags": ["origem-indicacao-medica"] }
--   - transfer_*: { "includeSummary": true }
-- ============================================================================

CREATE TABLE IF NOT EXISTS "unit_actions" (
  "id"                    TEXT        PRIMARY KEY,
  "unit_id"               TEXT        NOT NULL,
  "condition_description" TEXT        NOT NULL,
  "action_kind"           TEXT        NOT NULL,
  "action_params"         JSONB       NOT NULL DEFAULT '{}',
  "notes"                 TEXT,
  "enabled"               BOOLEAN     NOT NULL DEFAULT TRUE,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "unit_actions_unit_id_fkey" FOREIGN KEY ("unit_id")
    REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "unit_actions_unit_id_enabled_idx"
  ON "unit_actions" ("unit_id", "enabled");
