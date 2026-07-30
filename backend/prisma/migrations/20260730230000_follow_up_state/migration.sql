-- Estado do reengajamento por conversa.
--
-- O sistema já dizia ao paciente "te chamo depois" — e nunca chamava: existia
-- configuração (follow_up_enabled) e prompt, mas nenhum worker enviando. Isto
-- é o que faltava pra promessa ser verdadeira.
--
-- follow_up_step é o degrau já enviado e ZERA quando o paciente responde: quem
-- voltou a falar não é quem sumiu, e recomeçar a escada do zero é o
-- comportamento certo se ele sumir de novo.
--
-- follow_up_stopped_reason congela de vez (agendou, pediu pra parar, escada
-- esgotada). Sem isso, quem já marcou consulta continuaria recebendo "ainda
-- está aí?" — o caminho mais curto entre reengajar e virar spam.
ALTER TABLE "conversations" ADD COLUMN "follow_up_step" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "conversations" ADD COLUMN "follow_up_last_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "follow_up_stopped_reason" TEXT;

CREATE INDEX "conversations_unit_id_follow_up_step_last_message_at_idx"
  ON "conversations"("unit_id", "follow_up_step", "last_message_at");
