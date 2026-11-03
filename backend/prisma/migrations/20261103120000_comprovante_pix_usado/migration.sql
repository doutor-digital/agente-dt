-- Comprovantes de Pix aceitos pela Sofia para marcar consulta sozinha (Boa Vista, 03/11/2026).
-- O e2e é único: o mesmo comprovante não marca duas consultas. Nasce vazia; sem FK de propósito (apagar a unidade não libera o e2e).
-- Migration manual e aditiva (nunca `migrate dev`).
CREATE TABLE IF NOT EXISTS "comprovantes_pix_usados" (
    "id" TEXT NOT NULL,
    "e2e" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kommo_lead_id" INTEGER NOT NULL,
    "valor_centavos" INTEGER NOT NULL,
    "favorecido" TEXT,
    "id_schedule" INTEGER,
    "consulta_em" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comprovantes_pix_usados_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "comprovantes_pix_usados_e2e_key" ON "comprovantes_pix_usados"("e2e");
CREATE INDEX IF NOT EXISTS "comprovantes_pix_usados_unit_id_kommo_lead_id_idx" ON "comprovantes_pix_usados"("unit_id", "kommo_lead_id");
