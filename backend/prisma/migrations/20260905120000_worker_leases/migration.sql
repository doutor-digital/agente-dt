-- Liderança dos workers periódicos: só o processo que detém o lease roda
-- follow-up, reativação, alertas, juiz, custos e livro de resultados.
--
-- Em 04/09/2026 17:43Z o Swarm marcou a task nova como "Failed (137)" e subiu
-- outra, mas o container da primeira continuou vivo e saudável. Dois processos,
-- dois workers de follow-up, e cada cobrança saiu duas vezes com texto diferente
-- (Lucilene, Araguaína, 05/09 08:21). Deploy start-first abre a mesma janela.
-- Esta tabela é a única fonte de verdade sobre quem pode rodar os workers.
CREATE TABLE "worker_leases" (
  "name"       TEXT NOT NULL,
  "owner"      TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "worker_leases_pkey" PRIMARY KEY ("name")
);
