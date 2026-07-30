-- Ponte entre o lead do Kommo e o lead da franquia.
--
-- Os dois sistemas têm cadastros independentes e nenhum conhece o id do outro.
-- Sem esta tabela não há como saber se um lead já foi enviado — e a API da
-- franquia NÃO TEM exclusão de lead (testado: 404 nas duas formas), então cada
-- duplicata é permanente e só some na mão, na interface deles.
--
-- O unique é a trava contra o retry do webhook do Kommo, que reentrega o mesmo
-- evento mais de uma vez.
CREATE TABLE "spine_lead_links" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kommo_lead_id" INTEGER NOT NULL,
    "spine_id_lead" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spine_lead_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "spine_lead_links_unit_id_kommo_lead_id_key" ON "spine_lead_links"("unit_id", "kommo_lead_id");
CREATE INDEX "spine_lead_links_unit_id_created_at_idx" ON "spine_lead_links"("unit_id", "created_at" DESC);

ALTER TABLE "spine_lead_links" ADD CONSTRAINT "spine_lead_links_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
