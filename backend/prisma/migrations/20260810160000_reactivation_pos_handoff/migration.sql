-- Reativação pós-handoff: nunca perder lead quente.
-- Aditiva e segura (sem DROP, sem NOT NULL sem default). Aplicar em prod via
-- `prisma db execute` + `prisma migrate resolve --applied` (ver project_prisma_migration_drift).

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "handoff_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "reactivations" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "reactivation_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Acelera a varredura do worker: só conversas com handoff pendente interessam.
CREATE INDEX IF NOT EXISTS "conversations_handoff_at_idx" ON "conversations" ("handoff_at");
