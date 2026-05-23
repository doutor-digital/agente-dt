-- Flag pra que uma regra de captura também atualize o título do card no Kommo
-- quando dispara. Usado pelo caso "Nome da pessoa" — antes vivia acoplado ao
-- toggle Unit.collectNameEnabled, agora vira por-regra (mais flexível).

ALTER TABLE "lead_field_rules"
  ADD COLUMN "updates_lead_title" BOOLEAN NOT NULL DEFAULT false;
