-- O "entendi" de cada passo que o widget ensina no cartão, por pessoa (usuário do Kommo).
-- Nasce vazia: quem nunca clicou vê todos os passos, que é o comportamento certo para quem chega.
CREATE TABLE "widget_passos" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kommo_user_id" INTEGER NOT NULL,
    "passo" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_passos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "widget_passos_unit_id_kommo_user_id_passo_key" ON "widget_passos"("unit_id", "kommo_user_id", "passo");
CREATE INDEX "widget_passos_unit_id_criado_em_idx" ON "widget_passos"("unit_id", "criado_em");

ALTER TABLE "widget_passos" ADD CONSTRAINT "widget_passos_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
