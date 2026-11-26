-- Relatórios da InfinitePay importados (extrato, recebíveis e vendas), 26/11/2026. Tabelas NOVAS: nada existente muda.
-- A API da InfinitePay não lê isso; a clínica exporta o relatório do app e o conector importa. Sem número de conta nem CPF; a descrição pode conter o nome de quem pagou.
-- CreateTable
CREATE TABLE "infinitepay_importacoes" (
    "id" TEXT NOT NULL,
    "unit_slug" TEXT NOT NULL,
    "relatorio" TEXT NOT NULL,
    "formato" TEXT NOT NULL,
    "leiaute" TEXT,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "periodo_inicio" DATE,
    "periodo_fim" DATE,
    "linhas_lidas" INTEGER NOT NULL,
    "linhas_novas" INTEGER NOT NULL,
    "importado_por" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "infinitepay_importacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infinitepay_movimentos" (
    "id" TEXT NOT NULL,
    "unit_slug" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "data" DATE NOT NULL,
    "data_prevista" DATE,
    "valor_centavos" INTEGER NOT NULL,
    "descricao" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "importacao_id" TEXT NOT NULL,

    CONSTRAINT "infinitepay_movimentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infinitepay_vendas" (
    "id" TEXT NOT NULL,
    "unit_slug" TEXT NOT NULL,
    "quando" TIMESTAMP(3) NOT NULL,
    "valor_bruto_centavos" INTEGER NOT NULL,
    "valor_liquido_centavos" INTEGER,
    "forma" TEXT NOT NULL,
    "parcelas" INTEGER,
    "bandeira" TEXT,
    "status" TEXT,
    "chave" TEXT NOT NULL,
    "importacao_id" TEXT NOT NULL,

    CONSTRAINT "infinitepay_vendas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "infinitepay_importacoes_unit_slug_created_at_idx" ON "infinitepay_importacoes"("unit_slug", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "infinitepay_importacoes_unit_slug_sha256_key" ON "infinitepay_importacoes"("unit_slug", "sha256");

-- CreateIndex
CREATE INDEX "infinitepay_movimentos_unit_slug_data_idx" ON "infinitepay_movimentos"("unit_slug", "data");

-- CreateIndex
CREATE UNIQUE INDEX "infinitepay_movimentos_unit_slug_tipo_chave_key" ON "infinitepay_movimentos"("unit_slug", "tipo", "chave");

-- CreateIndex
CREATE INDEX "infinitepay_vendas_unit_slug_quando_idx" ON "infinitepay_vendas"("unit_slug", "quando");

-- CreateIndex
CREATE UNIQUE INDEX "infinitepay_vendas_unit_slug_chave_key" ON "infinitepay_vendas"("unit_slug", "chave");

-- AddForeignKey
ALTER TABLE "infinitepay_movimentos" ADD CONSTRAINT "infinitepay_movimentos_importacao_id_fkey" FOREIGN KEY ("importacao_id") REFERENCES "infinitepay_importacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infinitepay_vendas" ADD CONSTRAINT "infinitepay_vendas_importacao_id_fkey" FOREIGN KEY ("importacao_id") REFERENCES "infinitepay_importacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

