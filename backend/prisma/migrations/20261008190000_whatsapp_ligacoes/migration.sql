-- Ligação pelo WhatsApp no widget do Kommo (Calling API da Meta) — 08/10/2026.
-- Só cria tabelas novas: nada existente muda. Nascem vazias, e a chave "ligacao-whatsapp" nasce desligada.

-- CreateTable
CREATE TABLE "whatsapp_ligacoes" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "lead_id" INTEGER NOT NULL,
    "telefone" TEXT NOT NULL,
    "chave_telefone" TEXT NOT NULL,
    "wa_call_id" TEXT,
    "kommo_user_id" INTEGER,
    "kommo_user_nome" TEXT,
    "origem" TEXT NOT NULL DEFAULT 'cartao',
    "status" TEXT NOT NULL DEFAULT 'iniciando',
    "resultado" TEXT,
    "sem_combinar" BOOLEAN NOT NULL DEFAULT false,
    "modo" TEXT NOT NULL DEFAULT 'ligado',
    "sdp_resposta" TEXT,
    "tocou_em" TIMESTAMP(3),
    "atendida_em" TIMESTAMP(3),
    "encerrada_em" TIMESTAMP(3),
    "duracao_seg" INTEGER,
    "erro" TEXT,
    "registrada_em" TIMESTAMP(3),
    "kommo_registro" TEXT,
    "criada_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizada_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_ligacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_ligacao_pacientes" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "chave_telefone" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "lead_id" INTEGER,
    "nome" TEXT,
    "permissao" TEXT NOT NULL DEFAULT 'sem',
    "permissao_ate" TIMESTAMP(3),
    "permanente" BOOLEAN NOT NULL DEFAULT false,
    "respondeu_em" TIMESTAMP(3),
    "pedidos_em" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "conferida_em" TIMESTAMP(3),
    "perguntou_em" TIMESTAMP(3),
    "nao_atendidas_seguidas" INTEGER NOT NULL DEFAULT 0,
    "ultima_nao_atendida_em" TIMESTAMP(3),
    "ultima_ligacao_em" TIMESTAMP(3),
    "ultima_contada" TEXT,
    "ultimo_resultado" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_ligacao_pacientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_ligacao_config" (
    "unit_id" TEXT NOT NULL,
    "taxa_minima" INTEGER,
    "amostra_minima" INTEGER,
    "max_sem_atender" INTEGER,
    "texto_permissao" TEXT,
    "modelo_permissao" TEXT,
    "fila_pausada_ate" TIMESTAMP(3),
    "fila_pausada_motivo" TEXT,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_ligacao_config_pkey" PRIMARY KEY ("unit_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_ligacoes_wa_call_id_key" ON "whatsapp_ligacoes"("wa_call_id");

-- CreateIndex
CREATE INDEX "whatsapp_ligacoes_unit_id_criada_em_idx" ON "whatsapp_ligacoes"("unit_id", "criada_em");

-- CreateIndex
CREATE INDEX "whatsapp_ligacoes_unit_id_chave_telefone_criada_em_idx" ON "whatsapp_ligacoes"("unit_id", "chave_telefone", "criada_em");

-- CreateIndex
CREATE INDEX "whatsapp_ligacoes_status_atualizada_em_idx" ON "whatsapp_ligacoes"("status", "atualizada_em");

-- CreateIndex
CREATE INDEX "whatsapp_ligacao_pacientes_unit_id_permissao_idx" ON "whatsapp_ligacao_pacientes"("unit_id", "permissao");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_ligacao_pacientes_unit_id_chave_telefone_key" ON "whatsapp_ligacao_pacientes"("unit_id", "chave_telefone");

-- AddForeignKey
ALTER TABLE "whatsapp_ligacoes" ADD CONSTRAINT "whatsapp_ligacoes_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_ligacao_pacientes" ADD CONSTRAINT "whatsapp_ligacao_pacientes_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

