-- UnitAction: passa de "1 ação por regra" pra "N ações por regra".
-- Estratégia segura: adiciona `actions` JSONB, backfill, mantém campos legados
-- com default vazio pro rollback ser barato. Drop dos legados em migração
-- futura quando o código rodar estável por algumas semanas.

-- 1) Coluna nova.
ALTER TABLE "unit_actions"
  ADD COLUMN "actions" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2) Backfill — cada regra existente vira array de 1 elemento.
UPDATE "unit_actions"
SET "actions" = jsonb_build_array(
  jsonb_build_object(
    'kind',   "action_kind",
    'params', "action_params"
  )
)
WHERE jsonb_array_length("actions") = 0
  AND "action_kind" IS NOT NULL
  AND "action_kind" <> '';

-- 3) Afrouxa NOT NULL dos legados pra escritas novas poderem omiti-los.
ALTER TABLE "unit_actions"
  ALTER COLUMN "action_kind" SET DEFAULT '';
