-- Livro de resultados: uma linha por conversa — o que a IA fez e o que aconteceu depois.
--
-- Até aqui a Sofia era avaliada por um juiz que lê a conversa (estilo). A recompensa
-- que interessa é outra: consulta marcada que virou paciente na cadeira. Esta tabela
-- fecha o ciclo mensagem → AGENDADO (Kommo) → ATENDIDO / NÃO COMPARECEU (franquia),
-- por conversa, para a reflexão semanal e os experimentos aprenderem com resultado.
CREATE TABLE "conversation_outcomes" (
  "id"                    TEXT NOT NULL,
  "unit_id"               TEXT NOT NULL,
  "conversation_id"       TEXT NOT NULL,
  "kommo_lead_id"         INTEGER NOT NULL,
  "inicio_em"             TIMESTAMP(3) NOT NULL,
  "ultima_msg_em"         TIMESTAMP(3),
  "msgs_paciente"         INTEGER NOT NULL DEFAULT 0,
  "msgs_ia"               INTEGER NOT NULL DEFAULT 0,
  "primeira_resposta_seg" INTEGER,
  "consultas_agenda"      INTEGER NOT NULL DEFAULT 0,
  "horarios_oferecidos"   INTEGER NOT NULL DEFAULT 0,
  "preco_na_msg"          INTEGER,
  "follow_ups"            INTEGER NOT NULL DEFAULT 0,
  "handoff"               BOOLEAN NOT NULL DEFAULT false,
  "agendou_ia"            BOOLEAN NOT NULL DEFAULT false,
  "agendou_ia_em"         TIMESTAMP(3),
  "agendado_para"         TEXT,
  "spine_id_schedule"     INTEGER,
  "etapa_kommo"           TEXT,
  "agendou_kommo"         BOOLEAN NOT NULL DEFAULT false,
  "data_consulta_kommo"   TIMESTAMP(3),
  "situacao_kommo"        TEXT,
  "pg_antecipado"         BOOLEAN,
  "status_franquia"       TEXT,
  "compareceu"            BOOLEAN,
  "desfecho"              TEXT NOT NULL DEFAULT 'em_conversa',
  "final"                 BOOLEAN NOT NULL DEFAULT false,
  "calculado_em"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_outcomes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "conversation_outcomes_conversation_id_key" ON "conversation_outcomes"("conversation_id");
CREATE INDEX "conversation_outcomes_unit_id_inicio_em_idx" ON "conversation_outcomes"("unit_id", "inicio_em");
CREATE INDEX "conversation_outcomes_unit_id_desfecho_idx" ON "conversation_outcomes"("unit_id", "desfecho");
