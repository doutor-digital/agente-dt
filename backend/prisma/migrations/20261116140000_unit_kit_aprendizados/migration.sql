-- Marcador de que o kit de unidade já gravou os aprendizados da assistente (uma vez só). Coluna nova, nula: nada a preencher, nada existente muda.
ALTER TABLE "units" ADD COLUMN "kit_aprendizados_em" TIMESTAMP(3);
