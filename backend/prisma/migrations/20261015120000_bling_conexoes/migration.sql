-- Conexão com o Bling (ERP) por unidade — HM Tecnologia. Tabela nova e VAZIA: nenhuma unidade muda até
-- alguém gravar as credenciais do aplicativo e autorizar.
CREATE TABLE "bling_conexoes" (
    "unit_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "expira_em" TIMESTAMP(3),
    "refresh_em" TIMESTAMP(3),
    "escopos" TEXT,
    "estado" TEXT,
    "estado_em" TIMESTAMP(3),
    "conectado_em" TIMESTAMP(3),
    "conectado_por" TEXT,
    "ultimo_erro" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bling_conexoes_pkey" PRIMARY KEY ("unit_id")
);

CREATE UNIQUE INDEX "bling_conexoes_estado_key" ON "bling_conexoes"("estado");

ALTER TABLE "bling_conexoes" ADD CONSTRAINT "bling_conexoes_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
