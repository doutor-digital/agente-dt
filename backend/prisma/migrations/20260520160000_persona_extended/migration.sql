-- ============================================================================
-- Estende a persona da Unit com 3 controles finos pra o dono da clínica:
--   - persona_response_length     : "curta" | "normal" | "detalhada"
--   - persona_language            : BCP-47 simplificado (pt-BR / en-US / es-ES / fr-FR)
--   - persona_response_delay_sec  : pausa em segundos antes da resposta sair
--                                    (simula "digitando…" humano, 0 = imediato)
--
-- Defaults conservadores pra não mudar comportamento pra Units existentes.
-- ============================================================================

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_response_length"     TEXT    NOT NULL DEFAULT 'normal';
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_language"            TEXT    NOT NULL DEFAULT 'pt-BR';
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_response_delay_sec"  INTEGER NOT NULL DEFAULT 0;
