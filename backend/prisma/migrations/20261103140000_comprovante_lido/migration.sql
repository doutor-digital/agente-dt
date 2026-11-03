-- A leitura de cada imagem de comprovante de Pix, feita pelo servidor (Boa Vista, 03/11/2026). Migration manual e aditiva (nunca `migrate dev`).
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
    "entregue_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comprovantes_lidos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "comprovantes_lidos_unit_id_kommo_lead_id_fonte_key" ON "comprovantes_lidos"("unit_id", "kommo_lead_id", "fonte");
CREATE INDEX IF NOT EXISTS "comprovantes_lidos_unit_id_kommo_lead_id_criado_em_idx" ON "comprovantes_lidos"("unit_id", "kommo_lead_id", "criado_em");
