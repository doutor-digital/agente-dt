-- Etapas em que o alerta de SLA vale (ex: Entrada, Em Qualificação, Em
-- Negociação). Vazio = qualquer etapa não-terminal. Ver sla-alert-worker.ts.
ALTER TABLE "units" ADD COLUMN "sla_alert_status_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
