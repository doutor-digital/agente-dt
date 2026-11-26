-- Marca de REVISÃO nos links da InfinitePay (26/11/2026): estorno/cancelamento avisado pelo webhook e NÃO confirmado pela API não muda o status; fica marcado aqui.
-- Coluna nova e nula: nada existente muda.
ALTER TABLE "infinitepay_links" ADD COLUMN "revisao" TEXT;
