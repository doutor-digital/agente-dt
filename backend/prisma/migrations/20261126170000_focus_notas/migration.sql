-- Notas fiscais de serviço (NFS-e Nacional) emitidas pela Focus NFe pelo conector (26/11/2026). Tabela NOVA: nada existente muda, nenhuma unidade muda de comportamento.
-- A API da Focus não lista notas da NFS-e Nacional; este é o livro do que o conector emitiu, dos tetos da emissão e da trava de nota repetida. Sem CPF, nome nem endereço do paciente.
CREATE TABLE "focus_notas" (
    "id" TEXT NOT NULL,
    "unit_slug" TEXT NOT NULL,
    "ambiente" TEXT NOT NULL,
    "referencia" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'intencao',
    "serie_dps" INTEGER NOT NULL,
    "numero_dps" INTEGER NOT NULL,
    "valor_centavos" INTEGER NOT NULL,
    "data_competencia" TEXT NOT NULL,
    "tomador_mascarado" TEXT NOT NULL,
    "origem" TEXT,
    "chave_duplicata" TEXT NOT NULL,
    "criado_por" TEXT NOT NULL,
    "numero_nfse" TEXT,
    "codigo_verificacao" TEXT,
    "url_consulta" TEXT,
    "url_danfse" TEXT,
    "caminho_xml" TEXT,
    "emitida_em" TIMESTAMP(3),
    "cancelada_em" TIMESTAMP(3),
    "revisao" TEXT,
    "ultimo_evento" TEXT,
    "ultimo_evento_em" TIMESTAMP(3),
    "erro" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "focus_notas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "focus_notas_unit_slug_ambiente_referencia_key" ON "focus_notas"("unit_slug", "ambiente", "referencia");

CREATE UNIQUE INDEX "focus_notas_unit_slug_ambiente_serie_dps_numero_dps_key" ON "focus_notas"("unit_slug", "ambiente", "serie_dps", "numero_dps");

CREATE INDEX "focus_notas_unit_slug_ambiente_created_at_idx" ON "focus_notas"("unit_slug", "ambiente", "created_at");

CREATE INDEX "focus_notas_chave_duplicata_idx" ON "focus_notas"("chave_duplicata");
