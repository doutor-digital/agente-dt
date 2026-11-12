-- Ponte "Sofia atende todos" (12/11/2026): a Sofia responde fora do horário da IA até este instante.
ALTER TABLE "units" ADD COLUMN "ia_todos_ate" TIMESTAMP(3);
