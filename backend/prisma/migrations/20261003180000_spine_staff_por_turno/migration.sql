-- Profissional por turno, por unidade (Taubaté, 03/10/2026): sem isto a franquia põe a PRIMEIRA profissional
-- da lista em todo agendamento da IA. Nasce vazio: sem valor, nada muda (a franquia continua escolhendo).
ALTER TABLE "units" ADD COLUMN "spine_staff_por_turno" JSONB;
