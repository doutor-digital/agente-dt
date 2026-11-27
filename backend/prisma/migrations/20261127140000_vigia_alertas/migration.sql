-- Vigia da rede (27/11/2026): estado dos problemas avisados no Telegram. Só TABELA NOVA, sem FK e sem dado de paciente.
CREATE TABLE "vigia_alertas" (
    "chave" TEXT NOT NULL,
    "aberto_em" TIMESTAMP(3) NOT NULL,
    "ultimo_visto_em" TIMESTAMP(3) NOT NULL,
    "ultimo_aviso_em" TIMESTAMP(3),
    "lembretes" INTEGER NOT NULL DEFAULT 0,
    "resolvido_em" TIMESTAMP(3),

    CONSTRAINT "vigia_alertas_pkey" PRIMARY KEY ("chave")
);
