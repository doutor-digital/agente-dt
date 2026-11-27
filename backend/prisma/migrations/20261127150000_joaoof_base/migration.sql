-- CreateTable
CREATE TABLE "joaoof_unidades" (
    "slug" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "grupo_jid" TEXT,
    "notas" TEXT NOT NULL DEFAULT '',
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "joaoof_unidades_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "joaoof_pessoas" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "papel" TEXT NOT NULL DEFAULT 'desconhecido',
    "unidade_slug" TEXT,
    "notas" TEXT NOT NULL DEFAULT '',
    "vista_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "joaoof_pessoas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "joaoof_demandas" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "unidade_slug" TEXT,
    "solicitante" TEXT NOT NULL DEFAULT '',
    "titulo" TEXT NOT NULL,
    "descricao" TEXT NOT NULL DEFAULT '',
    "trecho" TEXT NOT NULL DEFAULT '',
    "categoria" TEXT NOT NULL DEFAULT 'outro',
    "prioridade" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'aberta',
    "responsavel" TEXT NOT NULL DEFAULT 'joao',
    "prazo" DATE,
    "prazo_texto" TEXT NOT NULL DEFAULT '',
    "fonte" TEXT NOT NULL DEFAULT 'grupo',
    "fonte_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "campos_do_joao" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "repeticoes" INTEGER NOT NULL DEFAULT 1,
    "motivo" TEXT NOT NULL DEFAULT '',
    "nota_joao" TEXT NOT NULL DEFAULT '',
    "vista_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "avisada_em" TIMESTAMP(3),
    "resolvida_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "joaoof_demandas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "joaoof_memorias" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "assunto" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "unidade_slug" TEXT,
    "origem" TEXT NOT NULL DEFAULT 'telegram',
    "usos" INTEGER NOT NULL DEFAULT 0,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "joaoof_memorias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "joaoof_avisos" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "demanda_id" TEXT,
    "texto" TEXT NOT NULL,
    "enviado" BOOLEAN NOT NULL DEFAULT false,
    "seco" BOOLEAN NOT NULL DEFAULT false,
    "reservado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "joaoof_avisos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "joaoof_conversa" (
    "id" TEXT NOT NULL,
    "quem" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "joaoof_conversa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "joaoof_estado" (
    "chave" TEXT NOT NULL,
    "valor" JSONB NOT NULL,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "joaoof_estado_pkey" PRIMARY KEY ("chave")
);

-- CreateIndex
CREATE UNIQUE INDEX "joaoof_unidades_grupo_jid_key" ON "joaoof_unidades"("grupo_jid");

-- CreateIndex
CREATE UNIQUE INDEX "joaoof_pessoas_chave_key" ON "joaoof_pessoas"("chave");

-- CreateIndex
CREATE INDEX "joaoof_pessoas_unidade_slug_idx" ON "joaoof_pessoas"("unidade_slug");

-- CreateIndex
CREATE UNIQUE INDEX "joaoof_demandas_numero_key" ON "joaoof_demandas"("numero");

-- CreateIndex
CREATE INDEX "joaoof_demandas_status_prioridade_idx" ON "joaoof_demandas"("status", "prioridade");

-- CreateIndex
CREATE INDEX "joaoof_demandas_unidade_slug_status_idx" ON "joaoof_demandas"("unidade_slug", "status");

-- CreateIndex
CREATE INDEX "joaoof_memorias_ativa_tipo_idx" ON "joaoof_memorias"("ativa", "tipo");

-- CreateIndex
CREATE INDEX "joaoof_memorias_unidade_slug_idx" ON "joaoof_memorias"("unidade_slug");

-- CreateIndex
CREATE INDEX "joaoof_avisos_criado_em_idx" ON "joaoof_avisos"("criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "joaoof_avisos_tipo_chave_key" ON "joaoof_avisos"("tipo", "chave");

-- CreateIndex
CREATE INDEX "joaoof_conversa_criado_em_idx" ON "joaoof_conversa"("criado_em");

-- Piloto da fase 1 (27/11/2026): as 3 unidades cujos grupos «Mkt | Dr Hérnia …» o Joaoof lê. Só o cadastro; nada liga sozinho.
INSERT INTO "joaoof_unidades" ("slug", "nome", "grupo_jid", "atualizado_em") VALUES
  ('doutor-hernia-parauapebas', 'Parauapebas', '120363380571317800@g.us', CURRENT_TIMESTAMP),
  ('doutor-hernia-acailandia', 'Açailândia', '120363399681615902@g.us', CURRENT_TIMESTAMP),
  ('doutor-hernia-araguaina', 'Araguaína', '120363378416973012@g.us', CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
