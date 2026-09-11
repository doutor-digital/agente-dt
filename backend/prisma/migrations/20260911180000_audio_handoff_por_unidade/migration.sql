-- Áudio que não dá pra transcrever vira handoff para a equipe, em vez de pedir
-- pro paciente digitar. Boa Vista está na API não oficial do WhatsApp: o áudio
-- não chega baixável, então a transcrição falha SEMPRE e o pedido se repete.
ALTER TABLE "units" ADD COLUMN "audio_handoff_enabled" BOOLEAN NOT NULL DEFAULT false;
