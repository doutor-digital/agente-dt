-- Marca de "o robô valor-consulta gravou este valor neste cartão" (unidade com pagamento antecipado): só o que ele mesmo gravou
-- pode ser trocado quando a forma de pagamento muda. Nasce vazia; migration manual e aditiva (nunca `migrate dev`).
CREATE TABLE IF NOT EXISTS "valor_consulta_gravado" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kommo_lead_id" INTEGER NOT NULL,
    "centavos" INTEGER NOT NULL,
    "qual" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "gravado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "valor_consulta_gravado_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "valor_consulta_gravado_chave_key" ON "valor_consulta_gravado"("unit_id", "kommo_lead_id");

DO $$ BEGIN
  ALTER TABLE "valor_consulta_gravado" ADD CONSTRAINT "valor_consulta_gravado_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
