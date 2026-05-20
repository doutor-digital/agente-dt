-- ============================================================================
-- Adiciona os 3 campos de "Fontes" estruturadas à Unit.
--
-- A aba Fontes substitui o systemPrompt cru por 3 documentos editáveis pelo
-- dono da clínica:
--   - source_papel    : papel da IA, fluxo SPIN, regras críticas (CREFITO,
--                       comercial), bifurcação por horário, limites
--   - source_produtos : condições tratadas, tecnologias, planos, regra de valores
--   - source_negocio  : endereço, contatos, profissionais, horário humano vs IA
--
-- Os 3 entram INTEIROS no system prompt (não passam por RAG). A tabela
-- knowledge_base_entry continua viva pra FAQ vetorizado (entradas curtas
-- pergunta/resposta).
-- ============================================================================

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "source_papel"    TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "source_produtos" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "source_negocio"  TEXT;
