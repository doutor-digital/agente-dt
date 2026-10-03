-- Pausa da IA por lead, com data para voltar (widget "Pausar a Sofia").
-- Nasce vazia: sem linha, o comportamento é o de hoje (só o campo "Pausar IA" do cartão decide).
CREATE TABLE "lead_pausas" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kommo_lead_id" INTEGER NOT NULL,
    "ate" TIMESTAMP(3) NOT NULL,
    "motivo" TEXT,
    "por" TEXT,
    "marcou_campo" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_pausas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_pausas_unit_id_kommo_lead_id_key" ON "lead_pausas"("unit_id", "kommo_lead_id");
CREATE INDEX "lead_pausas_ate_idx" ON "lead_pausas"("ate");

ALTER TABLE "lead_pausas" ADD CONSTRAINT "lead_pausas_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
