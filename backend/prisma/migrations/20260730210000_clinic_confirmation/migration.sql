-- Dados da mensagem de confirmação do agendamento.
--
-- Ficam na unidade, e não no prompt, por duas razões: mudam sem que ninguém
-- queira reescrever a persona, e o prompt é texto livre — endereço enterrado
-- num parágrafo é endereço que ninguém acha pra corrigir.
--
-- Nulos de propósito: enquanto vazios, a IA diz que a equipe confirma em vez
-- de inventar. Paciente indo no endereço errado é pior que paciente
-- perguntando onde é.
ALTER TABLE "units" ADD COLUMN "clinic_address" TEXT;
ALTER TABLE "units" ADD COLUMN "pix_key" TEXT;
ALTER TABLE "units" ADD COLUMN "pix_holder" TEXT;
