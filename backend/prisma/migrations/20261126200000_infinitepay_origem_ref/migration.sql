-- Aditiva: a referência de quem pediu o link (o Caixa). Única por unidade; nula nos links que já existem (o Postgres aceita vários nulos num índice único).
-- AlterTable
ALTER TABLE "infinitepay_links" ADD COLUMN     "origem_ref" TEXT;

-- quem pediu o link (conector | caixa | sofia): o livro dos tetos é por origem. Os links que já existem são do conector.
ALTER TABLE "infinitepay_links" ADD COLUMN     "origem" TEXT NOT NULL DEFAULT 'conector';

-- CreateIndex
CREATE UNIQUE INDEX "infinitepay_links_unit_slug_origem_ref_key" ON "infinitepay_links"("unit_slug", "origem_ref");
