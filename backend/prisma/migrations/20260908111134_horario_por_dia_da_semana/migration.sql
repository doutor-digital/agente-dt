-- Janela de atendimento por dia da semana.
-- A janela única não descreve Taubaté: lá a equipe humana cobre o comercial e a
-- IA cobre o resto — 20h→08h de segunda a sexta (atravessando a meia-noite) e
-- 8h→20h no fim de semana. Nulo em todas as outras unidades, que seguem usando
-- business_hours_start/end como sempre.
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "business_hours_by_day" JSONB;
