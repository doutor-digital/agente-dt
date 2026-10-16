-- Chaves de API de terceiros por unidade (Asaas, ClickSign), cifradas. Tabela nova e vazia: só o painel
-- de integrações (super-admin) escreve aqui.
CREATE TABLE "chaves_de_integracao" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "provedor" TEXT NOT NULL,
    "chave_cifrada" TEXT NOT NULL,
    "final_da_chave" TEXT NOT NULL,
    "conta" TEXT,
    "salvo_por" TEXT,
    "testado_em" TIMESTAMP(3),
    "ultimo_erro" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chaves_de_integracao_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chaves_de_integracao_unit_id_provedor_key" ON "chaves_de_integracao"("unit_id", "provedor");

ALTER TABLE "chaves_de_integracao" ADD CONSTRAINT "chaves_de_integracao_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
