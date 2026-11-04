-- Agenda da franquia no Calendário do Kommo, por unidade: tipo de tarefa, dono e duração.
-- Nasce vazia: sem linha, a unidade usa o automático (tipo "Consulta" da conta, dono = único usuário da clínica, 60 min) e Timbó
-- continua com o que está no .env. Migration manual e aditiva (nunca `migrate dev`).
CREATE TABLE IF NOT EXISTS "unit_calendario" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "task_type_id" INTEGER,
    "responsible_user_id" INTEGER,
    "duracao_min" INTEGER,
    "atualizado_por" TEXT,
    "atualizado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_calendario_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "unit_calendario_unit_id_key" ON "unit_calendario"("unit_id");

DO $$ BEGIN
  ALTER TABLE "unit_calendario" ADD CONSTRAINT "unit_calendario_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
