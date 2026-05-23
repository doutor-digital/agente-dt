-- Campo do Kommo onde a tool resumir_lead_para_sdr também grava o resumo
-- (além da nota interna). Permite que o SDR encontre o resumo mais recente
-- direto no card sem precisar abrir a aba de notas. Ambos NULL = legado
-- (só nota interna, comportamento anterior).

ALTER TABLE "units"
  ADD COLUMN "summary_custom_field_id"   INTEGER,
  ADD COLUMN "summary_custom_field_name" TEXT;
