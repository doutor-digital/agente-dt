-- Marcador de que o kit de unidade já gravou os aprendizados da assistente (uma vez só). Coluna nova, nula: nada existente muda.
ALTER TABLE "units" ADD COLUMN "kit_aprendizados_em" TIMESTAMP(3);

-- Unidade que JÁ tem aprendizados da própria clínica (fonte «unidade», escritos na página /aprendizados) conta como «já importada»: o kit nunca recria o que a dona editou ou apagou.
UPDATE "units" SET "kit_aprendizados_em" = NOW() WHERE "id" IN (SELECT DISTINCT "unit_id" FROM "unit_lessons" WHERE "source" = 'unidade');
