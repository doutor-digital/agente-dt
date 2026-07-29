-- Bloqueio manual de horário — o dado que a API da franquia não tem.
--
-- Quando o médico trava um horário no sistema da franquia, o bloqueio não
-- vira agendamento e não aparece em /api/schedules/search. Para nós aquele
-- horário parece vago e a IA marcaria em cima. Como não há como LER esse
-- dado, a recepção passa a REGISTRÁ-LO aqui, e a grade o subtrai.
--
-- Guardado em hora LOCAL (dia + HH:mm), não em UTC: é assim que a recepção
-- pensa e é assim que a grade é montada. Converter aqui só criaria mais uma
-- chance de divergência entre o que se digita e o que se vê.
CREATE TABLE "agenda_blocks" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "day_local" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agenda_blocks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agenda_blocks_unit_id_day_local_idx" ON "agenda_blocks"("unit_id", "day_local");

ALTER TABLE "agenda_blocks" ADD CONSTRAINT "agenda_blocks_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
