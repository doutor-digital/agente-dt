-- Disparo de campanha pela API oficial do WhatsApp (campanha -> onda -> destinatario).
-- Tres tabelas NOVAS e vazias: nada muda no comportamento de hoje. O disparo nasce em modo seco
-- (catalogo de automacoes, 'disparo-campanha', quandoVazio = seco): ate alguem ligar uma unidade, nada sai.
CREATE TABLE "disparo_campanhas" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "template" TEXT,
    "idioma" TEXT NOT NULL DEFAULT 'pt_BR',
    "texto_modelo" TEXT NOT NULL,
    "variaveis" JSONB NOT NULL DEFAULT '[]',
    "cabecalho" JSONB,
    "por_unidade" JSONB NOT NULL DEFAULT '{}',
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disparo_campanhas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "disparo_campanhas_slug_key" ON "disparo_campanhas"("slug");

CREATE TABLE "disparo_ondas" (
    "id" TEXT NOT NULL,
    "campanha_id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "idioma" TEXT NOT NULL,
    "texto_modelo" TEXT NOT NULL,
    "variaveis" JSONB NOT NULL,
    "cabecalho" JSONB,
    "estado" TEXT NOT NULL DEFAULT 'montada',
    "total" INTEGER NOT NULL DEFAULT 0,
    "resumo" JSONB NOT NULL DEFAULT '{}',
    "impressao" TEXT NOT NULL,
    "aprovada_por" TEXT,
    "aprovada_em" TIMESTAMP(3),
    "pausa_motivo" TEXT,
    "criada_por" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disparo_ondas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "disparo_ondas_estado_unit_id_idx" ON "disparo_ondas"("estado", "unit_id");
CREATE INDEX "disparo_ondas_campanha_id_unit_id_idx" ON "disparo_ondas"("campanha_id", "unit_id");

CREATE TABLE "disparo_destinatarios" (
    "id" TEXT NOT NULL,
    "onda_id" TEXT NOT NULL,
    "campanha_id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "nome_completo" TEXT,
    "kommo_lead_id" INTEGER,
    "estado" TEXT NOT NULL DEFAULT 'pendente',
    "motivo" TEXT,
    "wamid" TEXT,
    "simulado_em" TIMESTAMP(3),
    "enviado_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disparo_destinatarios_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "disparo_destinatarios_pessoa_key" ON "disparo_destinatarios"("campanha_id", "unit_id", "chave");
CREATE INDEX "disparo_destinatarios_onda_id_estado_idx" ON "disparo_destinatarios"("onda_id", "estado");
CREATE INDEX "disparo_destinatarios_unit_id_estado_enviado_em_idx" ON "disparo_destinatarios"("unit_id", "estado", "enviado_em");
CREATE INDEX "disparo_destinatarios_wamid_idx" ON "disparo_destinatarios"("wamid");

ALTER TABLE "disparo_ondas" ADD CONSTRAINT "disparo_ondas_campanha_id_fkey"
  FOREIGN KEY ("campanha_id") REFERENCES "disparo_campanhas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "disparo_ondas" ADD CONSTRAINT "disparo_ondas_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "disparo_destinatarios" ADD CONSTRAINT "disparo_destinatarios_onda_id_fkey"
  FOREIGN KEY ("onda_id") REFERENCES "disparo_ondas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
