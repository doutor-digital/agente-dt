-- CATEGORIA / SEGMENTO por unidade. Define a vertical (ex: "saude",
-- "energia_solar") que o prompt-composer usa pra escolher o preset de persona
-- (nome da IA + enquadramento). NULL = persona genérica (comportamento anterior).

ALTER TABLE "units" ADD COLUMN "category" TEXT;
