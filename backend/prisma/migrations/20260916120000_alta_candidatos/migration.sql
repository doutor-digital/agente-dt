-- Fila de decisões da clínica sobre tratamento (página /alta/:slug).
-- ALTA nunca é automática: é o "Ganho" do funil de tratamento e o gatilho dela
-- dispara um bot sem nenhuma condição. Quem aprova é gente.

CREATE TABLE "alta_candidatos" (
  "id"            TEXT NOT NULL,
  "unit_id"       TEXT NOT NULL,
  "lead_id"       INTEGER NOT NULL,
  "id_client"     INTEGER,
  "nome"          TEXT,
  "classe"        TEXT NOT NULL,
  "realizadas"    INTEGER NOT NULL DEFAULT 0,
  "previstas"     INTEGER NOT NULL DEFAULT 0,
  "ultima_sessao" TIMESTAMP(3),
  "estado"        TEXT NOT NULL DEFAULT 'pendente',
  "decidido_por"  TEXT,
  "decidido_em"   TIMESTAMP(3),
  "assinatura"    TEXT,
  "criado_em"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "atualizado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alta_candidatos_pkey" PRIMARY KEY ("id")
);

-- Um candidato por lead e classe: a varredura roda de novo sem duplicar a fila.
CREATE UNIQUE INDEX "alta_candidatos_unit_id_lead_id_classe_key"
  ON "alta_candidatos"("unit_id", "lead_id", "classe");

CREATE INDEX "alta_candidatos_unit_id_estado_idx"
  ON "alta_candidatos"("unit_id", "estado");

ALTER TABLE "alta_candidatos"
  ADD CONSTRAINT "alta_candidatos_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
