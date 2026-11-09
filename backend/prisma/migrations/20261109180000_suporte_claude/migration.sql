-- Agente de suporte (Claude Code 24 h na VPS): fila e resultado por demanda. Só colunas novas e vazias; migration manual e aditiva.
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "claude_status" TEXT;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "claude_autorizado_por" TEXT;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "claude_iniciado_em" TIMESTAMP(3);
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "claude_terminado_em" TIMESTAMP(3);
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "claude_resumo" TEXT;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "claude_pr_url" TEXT;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "claude_precisa_pessoa" BOOLEAN;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "claude_o_que_fazer" TEXT;
CREATE INDEX IF NOT EXISTS "suporte_demandas_claude_status_idx" ON "suporte_demandas"("claude_status");
