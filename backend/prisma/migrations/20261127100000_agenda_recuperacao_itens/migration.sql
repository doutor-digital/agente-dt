-- Lista diária de recuperação (26/11/2026): quem entrou na lista, para medir o retorno. Só TABELA NOVA, sem FK e sem nome de paciente (só um HMAC).
CREATE TABLE "agenda_recuperacao_itens" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "id_schedule" INTEGER NOT NULL,
    "paciente_chave" TEXT NOT NULL,
    "categoria" TEXT,
    "tipo" TEXT NOT NULL,
    "inicio_em" TIMESTAMP(3) NOT NULL,
    "modificado_em" TIMESTAMP(3),
    "modo" TEXT NOT NULL,
    "dia" TEXT NOT NULL,
    "kommo_lead_id" INTEGER,
    "envio" TEXT NOT NULL DEFAULT 'simulado',
    "listado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agenda_recuperacao_itens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agenda_recuperacao_itens_unit_id_listado_em_idx" ON "agenda_recuperacao_itens"("unit_id", "listado_em");

CREATE INDEX "agenda_recuperacao_itens_unit_id_paciente_chave_idx" ON "agenda_recuperacao_itens"("unit_id", "paciente_chave");

CREATE UNIQUE INDEX "agenda_recuperacao_itens_unit_id_id_schedule_modo_key" ON "agenda_recuperacao_itens"("unit_id", "id_schedule", "modo");
