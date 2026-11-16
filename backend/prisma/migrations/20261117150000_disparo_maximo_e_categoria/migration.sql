-- Disparo pelo CRM: máximo de pessoas por disparo (cortado na montagem e conferido na aprovação) e categoria do modelo (custo estimado).
-- Migration ADITIVA: duas colunas nulas; nada existente muda (as ondas do Kommo ficam sem máximo).
ALTER TABLE "disparo_ondas" ADD COLUMN IF NOT EXISTS "maximo_pessoas" INTEGER;
ALTER TABLE "disparo_ondas" ADD COLUMN IF NOT EXISTS "categoria_modelo" TEXT;
