-- Disparo de campanha: em que modo a unidade estava quando a onda foi aprovada. Aprovacao dada em modo seco nao vale
-- para envio real (ao ligar a unidade a onda volta para aprovacao). Coluna nova e anulavel: nada muda no que ja existe.
ALTER TABLE "disparo_ondas" ADD COLUMN "aprovada_modo" TEXT;
