-- Suporte a Google Gemini como provider da IA (unidade Serra). Aditivo e seguro.
-- NÃO altera OpenAI nem Anthropic. Aplicar via db execute + migrate resolve.
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "google_api_key" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "google_model" TEXT NOT NULL DEFAULT 'gemini-2.5-flash';
