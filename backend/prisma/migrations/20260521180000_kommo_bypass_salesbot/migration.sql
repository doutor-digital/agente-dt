-- ============================================================================
-- Toggle pra pular o Salesbot do Kommo no envio de resposta da IA.
-- Quando true, sendChatReply vai direto pra POST /chats/{chatId}/messages.
-- ============================================================================

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "kommo_bypass_salesbot" BOOLEAN NOT NULL DEFAULT FALSE;
