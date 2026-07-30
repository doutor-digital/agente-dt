-- Registrar também o que NÃO foi enviado.
--
-- Antes a tabela só guardava sucesso. Sucesso a gente enxerga abrindo o CRM da
-- franquia; o que sumiu no caminho, não — virava caça ao log, e log rotaciona.
-- Agora cada lead tem uma linha com o estado atual, e a tela consegue
-- responder "está chegando?" sem ninguém abrir terminal.
ALTER TABLE "spine_lead_links" ALTER COLUMN "spine_id_lead" DROP NOT NULL;
ALTER TABLE "spine_lead_links" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE "spine_lead_links" ADD COLUMN "motivo" TEXT;
ALTER TABLE "spine_lead_links" ADD COLUMN "tentativas" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "spine_lead_links" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "spine_lead_links_unit_id_status_idx" ON "spine_lead_links"("unit_id", "status");
