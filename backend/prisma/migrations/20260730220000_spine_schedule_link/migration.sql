-- A consulta atual de cada lead.
--
-- Regra do negócio: um lead tem no máximo um agendamento. Remarcar troca,
-- cancelar zera.
--
-- Guardar o idSchedule é o que torna cancelar e remarcar PRECISOS. A busca de
-- agendamentos da franquia devolve `clientName` e não `idClient`, então sem
-- esta coluna só restaria casar por nome — e cancelar a consulta de um
-- homônimo não tem desfazer.
ALTER TABLE "spine_lead_links" ADD COLUMN "spine_id_schedule" INTEGER;
ALTER TABLE "spine_lead_links" ADD COLUMN "agendado_para" TEXT;
