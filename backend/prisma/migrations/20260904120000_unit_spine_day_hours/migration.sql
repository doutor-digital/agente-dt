-- Horário de atendimento por dia da semana (hoje, só o sábado precisa).
--
-- Descoberto em 04/09/2026: as 10 unidades com agenda da franquia atendem
-- avaliação aos sábados (Parauapebas 07h30–11h, Marabá/Balsas até 13h…), mas a
-- Sofia estava travada em seg–sex em todas e recusava quem só pode no sábado.
-- Ligar o sábado com o horário da semana ofereceria 15h numa clínica que fecha
-- ao meio-dia; por isso o horário é por dia: {"6": {"start":"07:00","end":"13:00"}}.
-- NULL = todos os dias usam spine_agenda_start/end e o almoço padrão.
ALTER TABLE "units" ADD COLUMN "spine_day_hours" JSONB;
