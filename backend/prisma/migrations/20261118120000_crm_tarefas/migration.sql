-- Tarefas do CRM (mensagem agendada, ligação com lembrete, lembrete) e o WhatsApp pessoal de cada atendente. Tabelas novas: nada existente muda.
CREATE TABLE "crm_tarefa" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "conta" INTEGER NOT NULL,
    "caixa" INTEGER NOT NULL,
    "conversa_id" INTEGER NOT NULL,
    "contato_id" INTEGER,
    "contato_nome" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "quando" TIMESTAMP(3) NOT NULL,
    "responsavel_id" INTEGER NOT NULL,
    "responsavel_nome" TEXT NOT NULL,
    "texto" TEXT NOT NULL DEFAULT '',
    "modelo_nome" TEXT,
    "modelo_idioma" TEXT,
    "modelo_texto" TEXT,
    "modelo_variaveis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "estado" TEXT NOT NULL DEFAULT 'pendente',
    "motivo" TEXT,
    "confirmada_em" TIMESTAMP(3),
    "tentativa_em" TIMESTAMP(3),
    "enviada_em" TIMESTAMP(3),
    "mensagem_id" INTEGER,
    "lembrete_em" TIMESTAMP(3),
    "lembrete_resumo" TEXT,
    "simulado_em" TIMESTAMP(3),
    "simulado" TEXT,
    "resultado" TEXT,
    "resultado_em" TIMESTAMP(3),
    "resultado_por" TEXT,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "criado_por" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_tarefa_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crm_tarefa_unit_id_conta_estado_quando_idx" ON "crm_tarefa"("unit_id", "conta", "estado", "quando");
CREATE INDEX "crm_tarefa_estado_quando_idx" ON "crm_tarefa"("estado", "quando");
CREATE INDEX "crm_tarefa_conta_conversa_id_idx" ON "crm_tarefa"("conta", "conversa_id");

CREATE TABLE "crm_tarefa_zap" (
    "id" SERIAL NOT NULL,
    "conta" INTEGER NOT NULL,
    "agente_id" INTEGER NOT NULL,
    "agente_nome" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "atualizado_por" TEXT NOT NULL,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_tarefa_zap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_tarefa_zap_conta_agente_id_key" ON "crm_tarefa_zap"("conta", "agente_id");
