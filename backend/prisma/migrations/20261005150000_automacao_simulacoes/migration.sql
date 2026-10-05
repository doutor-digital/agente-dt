-- O que cada automação em "Só no papel" faria, para a tela de Automações mostrar antes de ligar.
-- Tabela nova e vazia: nada muda no comportamento de hoje.
CREATE TABLE "automacao_simulacoes" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "automacao" TEXT NOT NULL,
    "kommo_lead_id" INTEGER NOT NULL,
    "acao" TEXT NOT NULL,
    "alvo" TEXT NOT NULL,
    "valor" TEXT,
    "no_cartao" TEXT,
    "de_etapa" TEXT,
    "motivo" TEXT,
    "primeira_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultima_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automacao_simulacoes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automacao_simulacoes_chave_key" ON "automacao_simulacoes"("unit_id", "automacao", "kommo_lead_id", "alvo");
CREATE INDEX "automacao_simulacoes_lista_idx" ON "automacao_simulacoes"("unit_id", "automacao", "ultima_em" DESC);

ALTER TABLE "automacao_simulacoes" ADD CONSTRAINT "automacao_simulacoes_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
