-- Respostas da Sofia no Chatwoot e avaliações da equipe (👍/👎) — 13/11/2026
CREATE TABLE "sofia_mensagem" (
    "message_id" INTEGER NOT NULL,
    "conversa" INTEGER NOT NULL,
    "unit_slug" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "fala" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sofia_mensagem_pkey" PRIMARY KEY ("message_id")
);
CREATE INDEX "sofia_mensagem_conversa_idx" ON "sofia_mensagem"("conversa");

CREATE TABLE "sofia_avaliacao" (
    "id" TEXT NOT NULL,
    "unit_slug" TEXT NOT NULL,
    "conversa" INTEGER NOT NULL,
    "message_id" INTEGER,
    "nota" TEXT NOT NULL,
    "texto" TEXT,
    "quem_id" INTEGER,
    "quem_nome" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisada_em" TIMESTAMP(3),
    "revisada_por" TEXT,
    "revisada_como" TEXT,
    CONSTRAINT "sofia_avaliacao_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sofia_avaliacao_unit_slug_criado_em_idx" ON "sofia_avaliacao"("unit_slug", "criado_em");
CREATE INDEX "sofia_avaliacao_message_id_idx" ON "sofia_avaliacao"("message_id");
