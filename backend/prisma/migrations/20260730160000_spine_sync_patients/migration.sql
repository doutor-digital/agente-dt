-- Cadastro de PACIENTE na franquia, separado do espelhamento de lead.
--
-- O lead é o contato que chegou; o paciente (client, na API deles) é o cadastro
-- que a recepção usa, e o campo idClient do lead é o elo entre os dois.
--
-- Interruptor próprio porque a validação é mais dura (telefone em E.164
-- obrigatório) e porque, como o lead, paciente criado errado não tem exclusão
-- pela API — sai só por chamado no suporte da franquia.
ALTER TABLE "units" ADD COLUMN "spine_sync_patients" BOOLEAN NOT NULL DEFAULT false;

-- Guarda o paciente criado a partir do lead. Sem isto não há como saber se o
-- cadastro já existe do outro lado, e a trava contra duplicata permanente
-- deixa de valer para o paciente.
ALTER TABLE "spine_lead_links" ADD COLUMN "spine_id_client" INTEGER;
