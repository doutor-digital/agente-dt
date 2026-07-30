-- O nome que foi enviado, junto do vínculo.
--
-- Sem isto, tanto o histórico quanto a tela de cadastro de paciente mostram só
-- ids ("Kommo 13012964 -> franquia 5916621"). Ninguém confere um cadastro que
-- não pode ser apagado olhando para números — precisa ver de quem se trata.
ALTER TABLE "spine_lead_links" ADD COLUMN "nome" TEXT;
