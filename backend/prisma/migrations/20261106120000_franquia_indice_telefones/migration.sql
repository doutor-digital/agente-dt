-- Índice de telefones da franquia, por unidade (tipo-lead-chegada, 06/11/2026). Migration manual e ADITIVA (nunca `migrate dev`):
--   npx prisma db execute --file prisma/migrations/20261106120000_franquia_indice_telefones/migration.sql --schema prisma/schema.prisma
--   npx prisma migrate resolve --applied 20261106120000_franquia_indice_telefones
-- Reverter: DROP TABLE "franquia_telefones"; DROP TABLE "franquia_indice_status";  (é cache, nada se perde)
CREATE TABLE IF NOT EXISTS "franquia_telefones" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "id_na_franquia" INTEGER,
    "criado_na_franquia" TIMESTAMP(3),
    "atualizado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "franquia_telefones_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "franquia_telefones_unit_id_chave_origem_key" ON "franquia_telefones"("unit_id", "chave", "origem");

CREATE TABLE IF NOT EXISTS "franquia_indice_status" (
    "unit_id" TEXT NOT NULL,
    "completo_em" TIMESTAMP(3),
    "carga_completa_em" TIMESTAMP(3),
    "tentativa_em" TIMESTAMP(3),
    "clientes_total" INTEGER,
    "leads_ate" TEXT,
    "pacientes" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "resultado" TEXT,
    "erro" TEXT,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "franquia_indice_status_pkey" PRIMARY KEY ("unit_id")
);

DO $$ BEGIN
  ALTER TABLE "franquia_telefones" ADD CONSTRAINT "franquia_telefones_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "franquia_indice_status" ADD CONSTRAINT "franquia_indice_status_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
