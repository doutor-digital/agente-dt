-- Confirmação do sinal ao paciente (26/11/2026): duas colunas NULAS, nada existente muda. `confirmacao_em` é a reserva de «uma mensagem por sinal pago».
ALTER TABLE "sinais_pix" ADD COLUMN "confirmacao_em" TIMESTAMP(3);
ALTER TABLE "sinais_pix" ADD COLUMN "confirmacao" TEXT;
