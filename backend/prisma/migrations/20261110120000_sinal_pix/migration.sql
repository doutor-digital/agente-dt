-- Sofia 2.0: sinal por Pix (link de pagamento do Asaas da unidade). Aditiva: coluna nova e vazia (ninguém muda no merge)
-- e tabela nova e vazia.
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "sinal_pix_centavos" INTEGER;

CREATE TABLE IF NOT EXISTS "sinais_pix" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "clinica" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "valor_centavos" INTEGER NOT NULL,
    "vence_em" TEXT NOT NULL,
    "consulta_em" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pendente',
    "payment_id" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pago_em" TIMESTAMP(3),
    "avisado_em" TIMESTAMP(3),

    CONSTRAINT "sinais_pix_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sinais_pix_unit_id_link_id_key" ON "sinais_pix"("unit_id", "link_id");
CREATE INDEX IF NOT EXISTS "sinais_pix_clinica_lead_id_status_idx" ON "sinais_pix"("clinica", "lead_id", "status");
CREATE INDEX IF NOT EXISTS "sinais_pix_status_criado_em_idx" ON "sinais_pix"("status", "criado_em");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sinais_pix_unit_id_fkey') THEN
    ALTER TABLE "sinais_pix" ADD CONSTRAINT "sinais_pix_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
