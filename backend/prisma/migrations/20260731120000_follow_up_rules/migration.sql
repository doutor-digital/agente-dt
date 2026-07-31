-- Reengajamento POR ETAPA do funil, e por motivo de perda.
--
-- Uma escada só por unidade não serve: o objetivo muda com a etapa. Quem está
-- EM QUALIFICAÇÃO precisa voltar a conversar; quem está AGENDADO precisa pagar
-- o antecipado; quem foi PERDIDO precisa de um argumento que depende do MOTIVO
-- — "achou caro" e "vai viajar" não se recuperam com a mesma frase.
--
-- O unique inclui loss_reason_id porque PERDIDO tem uma regra por motivo, e
-- uma regra com motivo nulo vale como padrão para os motivos sem regra própria.
CREATE TABLE "follow_up_rules" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "status_id" INTEGER NOT NULL,
    "loss_reason_id" INTEGER,
    "loss_reason_name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_up_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "follow_up_rules_unit_id_status_id_loss_reason_id_key"
  ON "follow_up_rules"("unit_id", "status_id", "loss_reason_id");
CREATE INDEX "follow_up_rules_unit_id_enabled_idx" ON "follow_up_rules"("unit_id", "enabled");

ALTER TABLE "follow_up_rules" ADD CONSTRAINT "follow_up_rules_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
