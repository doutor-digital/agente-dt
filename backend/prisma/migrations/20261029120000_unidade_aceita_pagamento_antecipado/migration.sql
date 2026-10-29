-- Unidade sem pagamento antecipado (Timbó: só paga no dia, na clínica). Coluna aditiva com default true: nenhuma unidade
-- existente muda de comportamento; quem desliga é um UPDATE explícito depois do deploy.
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "accepts_advance_payment" BOOLEAN NOT NULL DEFAULT true;
