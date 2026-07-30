-- Espelhar leads no CRM da franquia — controle SEPARADO da agenda.
--
-- Consultar a agenda é leitura e não deixa rastro. Criar lead é escrita
-- PERMANENTE: a API da franquia não tem exclusão de lead (404 nas duas
-- formas), então todo cadastro errado só some na mão, na interface deles.
-- Ligar a agenda não pode significar, de tabela, começar a escrever no CRM
-- do cliente — por isso o default é false, mesmo em quem já tem agenda.
ALTER TABLE "units" ADD COLUMN "spine_sync_leads" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "units" ADD COLUMN "spine_default_source_id" INTEGER NOT NULL DEFAULT 20;
