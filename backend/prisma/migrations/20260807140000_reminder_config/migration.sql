-- Lembrete de véspera — config por unidade.
--
-- O worker de véspera (backend) varre as consultas de amanhã e aciona o
-- Salesbot abaixo, que envia o TEMPLATE de lembrete. Só template atravessa a
-- janela de 24h — quem marcou faz dias já está fora dela.
--
-- Nasce DESLIGADO: sem `reminder_enabled` e sem `reminder_salesbot_id` o worker
-- varre e não faz nada. Liga-se quando a unidade tem o template aprovado na
-- Meta e o Salesbot montado no Kommo.
ALTER TABLE "units" ADD COLUMN "reminder_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "units" ADD COLUMN "reminder_salesbot_id" INTEGER;
ALTER TABLE "units" ADD COLUMN "reminder_hour_local" INTEGER NOT NULL DEFAULT 9;
