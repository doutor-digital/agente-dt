-- TRIAGEM por unidade — define o que a IA precisa coletar antes de avançar o
-- lead de etapa. `triage_enabled` liga o bloco "# TRIAGEM" no prompt;
-- `triage_instructions` é o texto livre (lista do que coletar) que o dono da
-- unidade edita. NULL/false = comportamento anterior (sem bloco de triagem).

ALTER TABLE "units"
  ADD COLUMN "triage_enabled"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "triage_instructions" TEXT;
