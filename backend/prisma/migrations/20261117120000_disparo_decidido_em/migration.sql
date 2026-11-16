-- Freio de falhas seguidas do disparo pelo CRM: o momento em que o resultado de um envio ficou definitivo (falha ou entregue/lida).
-- Migration ADITIVA: uma coluna nula e um índice (a consulta do freio roda a cada rodada, por unidade).
ALTER TABLE "disparo_destinatarios" ADD COLUMN IF NOT EXISTS "decidido_em" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "disparo_destinatarios_unit_id_decidido_em_idx" ON "disparo_destinatarios"("unit_id", "decidido_em");
-- Falhas que já existiam em ondas do CRM ficam visíveis ao freio (sem elas a coluna nova o deixaria cego para o histórico). Sucessos não: só a varredura os decide.
UPDATE "disparo_destinatarios" d SET "decidido_em" = d."atualizado_em"
  FROM "disparo_ondas" o WHERE o."id" = d."onda_id" AND o."origem" = 'chatwoot' AND d."estado" = 'falhou' AND d."decidido_em" IS NULL;
