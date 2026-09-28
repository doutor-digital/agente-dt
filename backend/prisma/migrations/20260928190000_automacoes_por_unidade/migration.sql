-- Automações ligadas/desligadas por unidade, para a tela "Automações" do console.
-- Nasce VAZIA de propósito: sem linha, cada automação continua valendo pela variável de ambiente
-- de sempre, então esta migração não liga nem desliga nada em nenhuma unidade.
CREATE TABLE "unit_automacoes" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "automacao" TEXT NOT NULL,
    "estado" TEXT NOT NULL,
    "atualizado_por" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_automacoes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "unit_automacoes_unit_id_automacao_key" ON "unit_automacoes"("unit_id", "automacao");
CREATE INDEX "unit_automacoes_automacao_idx" ON "unit_automacoes"("automacao");

ALTER TABLE "unit_automacoes" ADD CONSTRAINT "unit_automacoes_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
