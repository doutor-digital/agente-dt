-- Duas unidades num Kommo só (Petrópolis + Caxias). Tabela nova e VAZIA: enquanto não houver linha,
-- toda unidade continua usando o próprio Kommo e o próprio token da franquia, exatamente como hoje.
CREATE TABLE "unit_crm_compartilhado" (
    "unit_id" TEXT NOT NULL,
    "conta_unit_id" TEXT NOT NULL,
    "rotulo" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "atualizado_por" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_crm_compartilhado_pkey" PRIMARY KEY ("unit_id")
);

CREATE UNIQUE INDEX "unit_crm_compartilhado_conta_unit_id_rotulo_key" ON "unit_crm_compartilhado"("conta_unit_id", "rotulo");

ALTER TABLE "unit_crm_compartilhado" ADD CONSTRAINT "unit_crm_compartilhado_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "unit_crm_compartilhado" ADD CONSTRAINT "unit_crm_compartilhado_conta_unit_id_fkey"
  FOREIGN KEY ("conta_unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
