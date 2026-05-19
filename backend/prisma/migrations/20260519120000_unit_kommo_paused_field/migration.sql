-- ============================================================================
-- Adiciona o ID do custom field "IA Pausada" por Unit.
--
-- Quando esta coluna está preenchida, o webhook do Kommo (e do Salesbot)
-- consulta esse field no lead ANTES de invocar o agente. Se o checkbox
-- estiver marcado, o agente é pulado — significa que o operador humano
-- assumiu a conversa.
--
-- A tool `pausar_ia` também escreve nesse campo.
-- ============================================================================

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "kommo_paused_field_id" INTEGER;
