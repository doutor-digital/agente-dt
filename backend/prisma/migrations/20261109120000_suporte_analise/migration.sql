-- Análise automática das demandas do menu de suporte (SUPORTE_ANALISE). Só colunas novas e vazias; migration manual e aditiva.
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "analise_iniciada_em" TIMESTAMP(3);
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "analise" JSONB;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "analise_falha" TEXT;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "prioridade" TEXT;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "prazo_em" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "suporte_demandas_analise_iniciada_em_idx" ON "suporte_demandas"("analise_iniciada_em");
