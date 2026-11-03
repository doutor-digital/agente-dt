-- Comprovantes de Pix da Boa Vista (03/11/2026): a leitura feita pelo servidor (comprovantes_lidos) e os E2E já usados para marcar consulta (comprovantes_pix_usados).
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

-- A leitura de cada imagem de comprovante, feita pelo servidor e presa à unidade + cartão + imagem. A conversa só leva a referência.
CREATE TABLE IF NOT EXISTS "comprovantes_lidos" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kommo_lead_id" INTEGER NOT NULL,
    "fonte" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "eh_comprovante" BOOLEAN NOT NULL DEFAULT false,
    "dados" JSONB,
    "erro" TEXT,
    "modelo" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comprovantes_lidos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "comprovantes_lidos_unit_id_kommo_lead_id_fonte_key" ON "comprovantes_lidos"("unit_id", "kommo_lead_id", "fonte");
CREATE INDEX IF NOT EXISTS "comprovantes_lidos_unit_id_kommo_lead_id_criado_em_idx" ON "comprovantes_lidos"("unit_id", "kommo_lead_id", "criado_em");
