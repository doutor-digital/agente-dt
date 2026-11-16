-- Disparo pelo CRM: o CRM nem sempre informa a categoria do modelo (marketing, utilidade…). Quando não informa, ela é ASSUMIDA como marketing e a onda guarda isso.
-- Migration ADITIVA: uma coluna com padrão false; nada existente muda.
ALTER TABLE "disparo_ondas" ADD COLUMN IF NOT EXISTS "categoria_assumida" BOOLEAN NOT NULL DEFAULT false;
-- Sem backfill: não há como saber, nas ondas já montadas, se «MARKETING» foi dito pelo CRM ou assumido. O erro possível é o lado seguro (pausa e pede para montar de novo).
