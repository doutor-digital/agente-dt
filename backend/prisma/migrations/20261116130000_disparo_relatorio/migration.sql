-- Relatório do disparo pelo CRM: o que o paciente fez depois do envio, gravado pela varredura (entregue, lida, respondeu).
-- Migration ADITIVA (expand): três colunas nulas. A origem Kommo não as usa; nenhuma linha existente muda.
ALTER TABLE "disparo_destinatarios" ADD COLUMN IF NOT EXISTS "entregue_em" TIMESTAMP(3);
ALTER TABLE "disparo_destinatarios" ADD COLUMN IF NOT EXISTS "lida_em" TIMESTAMP(3);
ALTER TABLE "disparo_destinatarios" ADD COLUMN IF NOT EXISTS "respondeu_em" TIMESTAMP(3);
