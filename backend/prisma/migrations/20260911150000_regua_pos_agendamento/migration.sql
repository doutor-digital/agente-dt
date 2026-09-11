-- Régua pós-agendamento: o que o paciente escolheu ao marcar e a confirmação de véspera.
ALTER TABLE "conversations" ADD COLUMN "pagamento_escolhido" TEXT;
ALTER TABLE "conversations" ADD COLUMN "confirmacao_d1_enviada_em" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "confirmacao_d1_resposta" TEXT;
