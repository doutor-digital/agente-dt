-- Ponte "Passar para a Sofia" (12/11/2026): a equipe libera a Sofia num lead fora do horário da IA, até este instante.
ALTER TABLE "conversations" ADD COLUMN "liberada_ate" TIMESTAMP(3);
