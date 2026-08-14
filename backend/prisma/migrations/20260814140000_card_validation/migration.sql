-- Validador de inconsistência do cartão: dedup de alerta + flag de ligar.
-- Ver src/lib/card-validation-worker.ts.
CREATE TABLE "card_alert" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "rule_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "card_alert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "card_alert_unit_id_lead_id_rule_key_key" ON "card_alert"("unit_id", "lead_id", "rule_key");
CREATE INDEX "card_alert_unit_id_idx" ON "card_alert"("unit_id");

ALTER TABLE "units" ADD COLUMN "card_validation_enabled" BOOLEAN NOT NULL DEFAULT false;
