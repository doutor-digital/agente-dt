-- ============================================================================
-- Base de conhecimento (RAG) por Unit.
--
-- Cada entry tem pergunta + resposta + embedding pré-computado (1536-dim).
-- Busca semântica é feita em memória pelo composer (cosine sim) e injeta
-- top-K matches no system prompt. Escala bem até 10K entries; acima disso
-- vale migrar pra pgvector.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "knowledge_base_entries" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_base_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "knowledge_base_entries_unit_id_idx"
  ON "knowledge_base_entries"("unit_id");

ALTER TABLE "knowledge_base_entries"
  ADD CONSTRAINT "knowledge_base_entries_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
