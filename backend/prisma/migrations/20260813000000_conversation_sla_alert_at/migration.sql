-- SLA de resposta humana pós-pausa: marca que os SDRs já foram avisados
-- (1 alerta por handoff). Ver src/lib/sla-alert-worker.ts.
ALTER TABLE "conversations" ADD COLUMN "sla_alert_at" TIMESTAMP(3);
