-- Links de pagamento da InfinitePay criados pelo conector (26/11/2026). Tabela NOVA: nada existente muda, nenhuma unidade muda de comportamento.
-- O que a API da InfinitePay não lista (links, vendas, saldo) fica só aqui; também é o livro dos tetos da criação de link.
CREATE TABLE "infinitepay_links" (
    "id" TEXT NOT NULL,
    "unit_slug" TEXT NOT NULL,
    "order_nsu" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'intencao',
    "url" TEXT,
    "valor_centavos" INTEGER NOT NULL,
    "descricao" TEXT NOT NULL,
    "valido_ate" TIMESTAMP(3),
    "criado_por" TEXT NOT NULL,
    "chave_duplicata" TEXT,
    "invoice_slug" TEXT,
    "transaction_nsu" TEXT,
    "forma_pagamento" TEXT,
    "parcelas" INTEGER,
    "valor_pago_centavos" INTEGER,
    "recibo_url" TEXT,
    "pago_em" TIMESTAMP(3),
    "liquidado_em" TIMESTAMP(3),
    "ultimo_evento" TEXT,
    "ultimo_evento_em" TIMESTAMP(3),
    "erro" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "infinitepay_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "infinitepay_links_unit_slug_created_at_idx" ON "infinitepay_links"("unit_slug", "created_at");

CREATE INDEX "infinitepay_links_chave_duplicata_idx" ON "infinitepay_links"("chave_duplicata");

CREATE UNIQUE INDEX "infinitepay_links_unit_slug_order_nsu_key" ON "infinitepay_links"("unit_slug", "order_nsu");
