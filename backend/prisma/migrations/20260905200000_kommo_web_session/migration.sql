-- Sessão web do Kommo usada pelo servidor para criar tokens de chat (nota de voz).
-- O cookie que vale por 91 dias é o refresh_token; a Kommo rotaciona os cookies a
-- cada uso, então o servidor precisa guardar a versão mais nova (cookie jar) em vez
-- de depender de uma cópia fixa do navegador — foi assim que a sessão "morreu" em
-- 05/09/2026 uma hora depois de copiada.
CREATE TABLE "kommo_web_sessions" (
  "id"            TEXT NOT NULL DEFAULT 'default',
  "session_id"    TEXT,
  "refresh_token" TEXT,
  "user_name"     TEXT,
  "ultimo_ok"     TIMESTAMP(3),
  "ultimo_erro"   TEXT,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kommo_web_sessions_pkey" PRIMARY KEY ("id")
);
