-- Reserva só depois do pagamento antecipado (Boa Vista: taxa de R$ 100 que garante
-- o horário e abate do total). Em 05/09/2026 a Sofia confirmou a consulta do
-- Lindomar para 09/09 sem a taxa. O manual da unidade já dizia "NÃO agende ainda";
-- a partir daqui a ferramenta agendar_consulta recusa enquanto não houver
-- comprovante lido na conversa ou o campo de pagamento marcado no cartão.
ALTER TABLE "units"
  ADD COLUMN "spine_booking_requires_payment" BOOLEAN NOT NULL DEFAULT false;
