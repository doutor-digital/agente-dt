-- Disparo de campanha, parte 2 (sobre 20261024120000_disparo_campanha): a oferta que a Sofia aprende e a retomada da onda
-- pausada por SAIR. So colunas NOVAS e anulaveis (ou com padrao): nada muda no que ja existe.
ALTER TABLE "disparo_campanhas" ADD COLUMN "oferta" TEXT;

ALTER TABLE "disparo_ondas" ADD COLUMN "pausa_causa" TEXT;
ALTER TABLE "disparo_ondas" ADD COLUMN "sair_aceitos" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "disparo_ondas" ADD COLUMN "retomada_por" TEXT;
ALTER TABLE "disparo_ondas" ADD COLUMN "retomada_em" TIMESTAMP(3);
