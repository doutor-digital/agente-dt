-- Pausa do menu de suporte (comando /pausar do @ddchamados_bot e botão do painel). Tabela nova e vazia; sem linha = não pausado. Migration aditiva.
-- CreateTable
CREATE TABLE IF NOT EXISTS "suporte_controle" (
    "id" TEXT NOT NULL,
    "pausado" BOOLEAN NOT NULL DEFAULT false,
    "pausado_em" TIMESTAMP(3),
    "pausado_por" TEXT,
    "ignoradas_na_pausa" INTEGER NOT NULL DEFAULT 0,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suporte_controle_pkey" PRIMARY KEY ("id")
);

