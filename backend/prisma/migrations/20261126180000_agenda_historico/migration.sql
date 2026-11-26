-- Histórico da agenda da franquia (26/11/2026). Só TABELA NOVA: nada existente muda e nenhuma unidade muda de comportamento (a automação
-- `recuperacao-agenda` nasce desligada). Sem FK para `units` e sem nome de paciente (só um HMAC).
CREATE TABLE "agenda_status_eventos" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "id_schedule" INTEGER NOT NULL,
    "paciente_chave" TEXT NOT NULL,
    "categoria" TEXT,
    "de_status" INTEGER,
    "para_status" INTEGER,
    "inicio_em" TIMESTAMP(3) NOT NULL,
    "inicio_anterior_em" TIMESTAMP(3),
    "modificado_em" TIMESTAMP(3),
    "visto_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agenda_status_eventos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agenda_status_eventos_unit_id_id_schedule_visto_em_idx" ON "agenda_status_eventos"("unit_id", "id_schedule", "visto_em");

CREATE INDEX "agenda_status_eventos_unit_id_paciente_chave_visto_em_idx" ON "agenda_status_eventos"("unit_id", "paciente_chave", "visto_em");

CREATE INDEX "agenda_status_eventos_unit_id_visto_em_idx" ON "agenda_status_eventos"("unit_id", "visto_em");
