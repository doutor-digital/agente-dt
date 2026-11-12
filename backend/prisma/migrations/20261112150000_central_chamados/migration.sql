-- Central do João (fase 1b): menções e não lidas do WhatsApp Web pessoal viram chamado. Tabela nova e vazia. Migration aditiva.
-- CreateTable
CREATE TABLE IF NOT EXISTS "central_chamados" (
    "id" TEXT NOT NULL,
    "chave_conversa" TEXT NOT NULL,
    "conversa" TEXT NOT NULL,
    "grupo" BOOLEAN NOT NULL DEFAULT false,
    "tipo" TEXT NOT NULL,
    "trecho" TEXT NOT NULL,
    "nao_lidas" INTEGER NOT NULL DEFAULT 0,
    "vezes" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'aberto',
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,
    "fechado_em" TIMESTAMP(3),

    CONSTRAINT "central_chamados_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "central_chamados_status_atualizado_em_idx" ON "central_chamados"("status", "atualizado_em");
CREATE INDEX IF NOT EXISTS "central_chamados_chave_conversa_idx" ON "central_chamados"("chave_conversa");

-- Um chamado ABERTO por conversa (o Prisma não descreve índice parcial; fica só aqui)
CREATE UNIQUE INDEX IF NOT EXISTS "central_chamados_um_aberto_por_conversa" ON "central_chamados"("chave_conversa") WHERE "status" = 'aberto';
