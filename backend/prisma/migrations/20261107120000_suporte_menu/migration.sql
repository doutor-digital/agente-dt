-- Menu de suporte no WhatsApp (SUPORTE_MENU): conversas, demandas (protocolo), dedupe de mensagens e envios (tetos).
-- Só tabelas novas e vazias; migration manual e aditiva (nunca `migrate dev`).
CREATE TABLE IF NOT EXISTS "suporte_conversas" (
    "id" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "passo" TEXT NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "nome" TEXT,
    "unidade_slug" TEXT,
    "unidade_nome" TEXT,
    "verificacao" TEXT NOT NULL DEFAULT 'nenhuma',
    "categoria" INTEGER,
    "protocolo" INTEGER,
    "avisou_em" TIMESTAMP(3),
    "versao" INTEGER NOT NULL DEFAULT 1,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suporte_conversas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "suporte_conversas_jid_key" ON "suporte_conversas"("jid");

CREATE TABLE IF NOT EXISTS "suporte_demandas" (
    "id" TEXT NOT NULL,
    "protocolo" SERIAL NOT NULL,
    "jid" TEXT NOT NULL,
    "nome" TEXT,
    "unidade_slug" TEXT,
    "verificacao" TEXT NOT NULL,
    "grupos_vistos" INTEGER NOT NULL DEFAULT 0,
    "categoria" INTEGER NOT NULL,
    "categoria_nome" TEXT NOT NULL,
    "relato" TEXT NOT NULL,
    "telegram_enviado" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suporte_demandas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "suporte_demandas_protocolo_key" ON "suporte_demandas"("protocolo");
CREATE INDEX IF NOT EXISTS "suporte_demandas_criado_em_idx" ON "suporte_demandas"("criado_em");

CREATE TABLE IF NOT EXISTS "suporte_mensagens_vistas" (
    "id" TEXT NOT NULL,
    "vista_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suporte_mensagens_vistas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "suporte_mensagens_vistas_vista_em_idx" ON "suporte_mensagens_vistas"("vista_em");

CREATE TABLE IF NOT EXISTS "suporte_envios" (
    "id" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "nova" BOOLEAN NOT NULL DEFAULT false,
    "enviado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suporte_envios_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "suporte_envios_enviado_em_idx" ON "suporte_envios"("enviado_em");
