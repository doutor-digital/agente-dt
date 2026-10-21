-- Cache curto da busca de horários da agenda (consultar_horarios), por unidade + dia. Ver src/lib/cache-agenda.ts.
-- Tabela nova e vazia; a chave cache-agenda nasce em "só no papel": a Sofia continua consultando a franquia em toda
-- busca até alguém ligar a chave na tela de Automações. Escrita à mão (nunca `prisma migrate dev`, que reseta o banco).
CREATE TABLE "agenda_cache_dias" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "dia" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "resultado" JSONB,
    "consultado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agenda_cache_dias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agenda_cache_dias_chave_key" ON "agenda_cache_dias"("unit_id", "dia", "chave");
CREATE INDEX "agenda_cache_dias_consultado_idx" ON "agenda_cache_dias"("consultado_em");

ALTER TABLE "agenda_cache_dias" ADD CONSTRAINT "agenda_cache_dias_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
