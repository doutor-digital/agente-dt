-- Memória de longo prazo do lead — o que a IA lembra de uma conversa pra outra.
--
-- O modelo LeadMemory existia no schema desde cedo, mas a migration nunca foi
-- gerada: a tabela não existia em produção e getLeadMemory/updater falhavam em
-- silêncio (centenas de vezes por dia, sem ninguém ver). Sem esta tabela a IA
-- recomeça do zero a cada atendimento — pergunta o nome, a queixa e o tempo de
-- dor que o paciente já contou semana passada.
--
-- Uma linha por (unit, lead). `summary` é o parágrafo curto; `facts` é o JSON
-- estruturado (queixa, etapa, preferências, objeções). `turns_since_update`
-- conta mensagens novas desde o último resumo, pra não re-resumir a cada turno.
CREATE TABLE "lead_memories" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "facts" JSONB NOT NULL DEFAULT '{}',
    "turns_since_update" INTEGER NOT NULL DEFAULT 0,
    "last_summarized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_memories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_memories_unit_id_lead_id_key" ON "lead_memories"("unit_id", "lead_id");

ALTER TABLE "lead_memories" ADD CONSTRAINT "lead_memories_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
