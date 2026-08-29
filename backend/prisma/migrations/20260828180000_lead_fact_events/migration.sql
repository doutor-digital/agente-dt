-- Histórico dos fatos do paciente: um evento por mudança, nunca sobrescrito.
--
-- `lead_memories.facts` continua sendo a foto do agora e não muda. Esta tabela
-- guarda o filme: quando cada fato foi aprendido, de que frase saiu, e o que
-- ele substituiu.
--
-- Append-only de propósito. Sem UPDATE nem DELETE — é o que permite responder
-- "por que a IA acha isso?" meses depois, e auditar extração errada antes que
-- ela vire decisão comercial permanente.

CREATE TABLE "lead_fact_events" (
    "id"             TEXT NOT NULL,
    "unit_id"        TEXT NOT NULL,
    "lead_id"        TEXT NOT NULL,
    "chave"          TEXT NOT NULL,
    "valor"          TEXT NOT NULL,
    "valor_anterior" TEXT,
    "evidencia"      TEXT,
    "supersedes_id"  TEXT,
    "observado_em"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_fact_events_pkey" PRIMARY KEY ("id")
);

-- A leitura natural é a linha do tempo de um paciente.
CREATE INDEX "lead_fact_events_unit_id_lead_id_observado_em_idx"
    ON "lead_fact_events"("unit_id", "lead_id", "observado_em");

-- E a outra: "quantas vezes a qualificação mudou nesta unidade?"
CREATE INDEX "lead_fact_events_unit_id_chave_observado_em_idx"
    ON "lead_fact_events"("unit_id", "chave", "observado_em");

ALTER TABLE "lead_fact_events"
    ADD CONSTRAINT "lead_fact_events_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, não CASCADE: se um evento antigo sumir, o novo continua valendo.
-- Perder o elo da corrente é ruim; perder o fato atual junto seria pior.
ALTER TABLE "lead_fact_events"
    ADD CONSTRAINT "lead_fact_events_supersedes_id_fkey"
    FOREIGN KEY ("supersedes_id") REFERENCES "lead_fact_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
