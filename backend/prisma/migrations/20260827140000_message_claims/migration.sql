-- Dedup de mensagem que sobrevive a restart, deploy e segunda réplica.
--
-- O dedup vivia num Map em memória de um processo só. Toda vez que o contêiner
-- reiniciava — e hoje mesmo houve dois deploys — a memória zerava e a mesma
-- mensagem do Kommo era reprocessada: a IA respondia de novo e a ação no CRM
-- duplicava. Com uma segunda réplica, os dois processos processariam a mesma
-- mensagem ao mesmo tempo, sem nem saber um do outro.
--
-- A chave é o id da mensagem por escopo, e a unicidade é do banco: quem inserir
-- primeiro ganha, o segundo recebe conflito e desiste. Isso é atômico mesmo com
-- dois processos concorrendo, coisa que Map nenhum resolve.
CREATE TABLE IF NOT EXISTS "message_claims" (
  "key"        TEXT         NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_claims_pkey" PRIMARY KEY ("key")
);

-- Só serve para a limpeza periódica varrer o que venceu sem escanear a tabela.
CREATE INDEX IF NOT EXISTS "message_claims_expires_at_idx"
  ON "message_claims" ("expires_at");
