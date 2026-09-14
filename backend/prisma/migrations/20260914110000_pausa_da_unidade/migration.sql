-- Pausa da IA por janela de tempo, ligada pela recepção da unidade.
ALTER TABLE "units" ADD COLUMN "pausa_desde" TIMESTAMP(3);
ALTER TABLE "units" ADD COLUMN "pausa_ate" TIMESTAMP(3);
ALTER TABLE "units" ADD COLUMN "pausa_motivo" TEXT;
ALTER TABLE "units" ADD COLUMN "pausa_por" TEXT;
ALTER TABLE "units" ADD COLUMN "pausa_codigo" TEXT;
