-- Facebook: mesmo agente de comentários, outra rede.
--
-- Campos espelhados em vez de compartilhados com o Instagram: as duas redes
-- têm o mesmo problema (comentário público → conversa privada) mas token,
-- endpoint de resposta privada e limites diferentes. Compartilhar colunas
-- economizaria espaço e tiraria a possibilidade de ligar uma rede sem a outra.
ALTER TABLE "units" ADD COLUMN "fb_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "units" ADD COLUMN "fb_page_id" TEXT;
ALTER TABLE "units" ADD COLUMN "fb_access_token" TEXT;
ALTER TABLE "units" ADD COLUMN "fb_verify_token" TEXT;
ALTER TABLE "units" ADD COLUMN "fb_app_secret" TEXT;
ALTER TABLE "units" ADD COLUMN "fb_dry_run" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "units" ADD COLUMN "fb_whatsapp_number" TEXT;
ALTER TABLE "units" ADD COLUMN "fb_public_signature" TEXT;
ALTER TABLE "units" ADD COLUMN "fb_delivery_mode" TEXT NOT NULL DEFAULT 'kommo';
ALTER TABLE "units" ADD COLUMN "fb_reply_field_id" INTEGER;
ALTER TABLE "units" ADD COLUMN "fb_comment_prompt" TEXT;

-- Uma tabela para as duas redes. O default 'instagram' preserva as linhas
-- existentes, que só podiam ter vindo de lá.
ALTER TABLE "instagram_comments" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'instagram';
CREATE INDEX "instagram_comments_unit_platform_created_idx"
  ON "instagram_comments"("unit_id", "platform", "created_at" DESC);
