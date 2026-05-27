-- Modo widget (handler `widget_request` do Salesbot): a resposta da IA é
-- entregue via return_url + execute_handlers [show…], alternativa ao PATCH no
-- campo "Resposta IA" + gatilho do Digital Pipeline. Por-unidade pra permitir
-- piloto. Defaults mantêm o comportamento atual (desligado).
ALTER TABLE "units" ADD COLUMN "kommo_widget_reply_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "units" ADD COLUMN "kommo_widget_secret" TEXT;
ALTER TABLE "units" ADD COLUMN "kommo_widget_salesbot_id" INTEGER;
