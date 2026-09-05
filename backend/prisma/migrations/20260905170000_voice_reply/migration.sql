-- Resposta em NOTA DE VOZ (espelho: só quando o paciente mandou áudio).
--
-- A API oficial do Kommo não tem mídia no caminho do Salesbot/widget (05/09/2026):
-- o que funciona é o serviço de chat interno (amojo) com um token criado da sessão
-- web do usuário. O token vale ~3 dias e fica aqui, por unidade, para não recriar a
-- cada envio. Toda falha na cadeia cai em texto pelo caminho normal.
ALTER TABLE "units" ADD COLUMN "voice_reply_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "kommo_chat_sessions" (
  "unit_id"          TEXT NOT NULL,
  "subdomain"        TEXT NOT NULL,
  "access_token"     TEXT NOT NULL,
  "refresh_token"    TEXT NOT NULL,
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "amojo_account_id" TEXT,
  "user_name"        TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kommo_chat_sessions_pkey" PRIMARY KEY ("unit_id")
);
