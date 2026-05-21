-- ============================================================================
-- Adiciona campos pra IA coletar nome do lead (atualiza título no Kommo) e
-- coletar origem ("como conheceu a clínica") via tag.
-- ============================================================================

-- COLETA DE NOME — IA pergunta o nome e atualiza o título do lead no Kommo
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "collect_name_enabled" BOOLEAN NOT NULL DEFAULT FALSE;

-- COLETA DE ORIGEM — IA pergunta como o lead conheceu a clínica e aplica tag "Origem: <fonte>"
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "collect_source_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "collect_source_options" TEXT[] NOT NULL DEFAULT ARRAY['Instagram','Google','Indicação','TikTok','Facebook'];
