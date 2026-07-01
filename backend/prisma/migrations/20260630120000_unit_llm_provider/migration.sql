-- Provedor de LLM do chat por unidade. "openai" (padrão) preserva o
-- comportamento atual de TODAS as unidades existentes. "anthropic" faz o
-- agente usar Claude (ex: claude-opus-4-8). Embeddings/transcrição seguem no
-- OpenAI (Anthropic não tem esses endpoints), por isso openai_api_key continua
-- sendo usado mesmo quando llm_provider = 'anthropic'.
ALTER TABLE "units" ADD COLUMN "llm_provider" TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE "units" ADD COLUMN "anthropic_api_key" TEXT;
ALTER TABLE "units" ADD COLUMN "anthropic_model" TEXT NOT NULL DEFAULT 'claude-opus-4-8';
