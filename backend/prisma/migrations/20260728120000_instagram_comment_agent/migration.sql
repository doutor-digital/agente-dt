-- Agente de comentários do Instagram.
--
-- Canal separado do WhatsApp: comentário público não é conversa. O agente
-- classifica, responde em público por template e puxa a pessoa pro DM.
--
-- ig_dry_run entra como TRUE pra TODAS as unidades existentes, de propósito:
-- ligar a feature não pode começar publicando texto gerado no perfil de
-- ninguém. Cada unidade desliga o dry run quando tiver lido a fila.
ALTER TABLE "units" ADD COLUMN "ig_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "units" ADD COLUMN "ig_user_id" TEXT;
ALTER TABLE "units" ADD COLUMN "ig_access_token" TEXT;
ALTER TABLE "units" ADD COLUMN "ig_verify_token" TEXT;
ALTER TABLE "units" ADD COLUMN "ig_app_secret" TEXT;
ALTER TABLE "units" ADD COLUMN "ig_dry_run" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "units" ADD COLUMN "ig_whatsapp_number" TEXT;
ALTER TABLE "units" ADD COLUMN "ig_public_signature" TEXT;

-- Um registro por comentário recebido. `comment_id` único é o que impede
-- responder duas vezes o mesmo comentário quando a Meta reentrega o webhook —
-- dedup em memória não sobrevive a deploy, e aqui o erro seria público.
CREATE TABLE "instagram_comments" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "media_id" TEXT,
    "parent_id" TEXT,
    "author_id" TEXT,
    "author_username" TEXT,
    "text" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OUTRO',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "public_reply" TEXT,
    "private_reply" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "public_sent_at" TIMESTAMP(3),
    "private_sent_at" TIMESTAMP(3),
    "skip_reason" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instagram_comments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instagram_comments_comment_id_key" ON "instagram_comments"("comment_id");
CREATE INDEX "instagram_comments_unit_id_created_at_idx" ON "instagram_comments"("unit_id", "created_at" DESC);
CREATE INDEX "instagram_comments_unit_id_status_idx" ON "instagram_comments"("unit_id", "status");

ALTER TABLE "instagram_comments" ADD CONSTRAINT "instagram_comments_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
