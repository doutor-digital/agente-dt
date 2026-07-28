-- Entrega da resposta de comentário PELO KOMMO, e prompt editável.
--
-- Por que "kommo" é o padrão: a integração nativa do Kommo com o Instagram já
-- tem as permissões da Meta aprovadas. Indo por ela, o comentário vira lead,
-- o agente responde e o Salesbot entrega — sem depender do nosso App Review,
-- que é o item mais lento do caminho. O modo "direct" (Graph API por conta
-- própria) continua disponível para quando a aprovação sair.
ALTER TABLE "units" ADD COLUMN "ig_delivery_mode" TEXT NOT NULL DEFAULT 'kommo';
ALTER TABLE "units" ADD COLUMN "ig_reply_field_id" INTEGER;
ALTER TABLE "units" ADD COLUMN "ig_comment_prompt" TEXT;
