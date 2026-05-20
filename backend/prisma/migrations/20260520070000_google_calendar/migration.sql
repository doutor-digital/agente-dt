-- ============================================================================
-- Integração com Google Calendar via OAuth 2.0.
--
-- Cada Unit pode conectar seu Google Calendar. Quando conectado, a IA
-- ganha a tool `agendar_consulta` que cria eventos no calendário da Unit.
-- Tokens são renovados automaticamente via refreshToken.
-- ============================================================================

ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "google_access_token" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "google_refresh_token" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "google_token_expires_at" TIMESTAMP(3);
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "google_calendar_id" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "google_authorized_email" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "google_authorized_at" TIMESTAMP(3);
