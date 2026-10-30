-- Pausa que a própria Sofia fez porque a equipe falou com o paciente (automação pausa-equipe).
-- Nasce vazia: sem linha aberta, ninguém volta sozinho — o comportamento de hoje (pausa até alguém desmarcar).
-- Migration manual e aditiva (nunca `migrate dev`).
CREATE TABLE IF NOT EXISTS "pausas_da_equipe" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kommo_lead_id" INTEGER NOT NULL,
    "pausado_em" TIMESTAMP(3) NOT NULL,
    "fala_em" TIMESTAMP(3) NOT NULL,
    "fala_autor" TEXT,
    "encerrada_em" TIMESTAMP(3),
    "desfecho" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pausas_da_equipe_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pausas_da_equipe_unit_id_kommo_lead_id_key" ON "pausas_da_equipe"("unit_id", "kommo_lead_id");
CREATE INDEX IF NOT EXISTS "pausas_da_equipe_encerrada_em_idx" ON "pausas_da_equipe"("encerrada_em");

ALTER TABLE "pausas_da_equipe" ADD CONSTRAINT "pausas_da_equipe_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
