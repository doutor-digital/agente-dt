-- Configuração do CRM (Chatwoot) por unidade — kit de unidade nova (14/11/2026).
-- Migration aditiva: duas tabelas novas. Nada existente é tocado. Segredo NÃO vai para o banco (só o sufixo da variável).
CREATE TABLE IF NOT EXISTS "unit_chatwoot" (
    "unit_id" TEXT NOT NULL,
    "prefixo_modelos" TEXT NOT NULL,
    "usuario_celular_id" INTEGER,
    "gerente_id" INTEGER,
    "meta_agendamentos_dia" INTEGER,
    "kapso_phone_number_id" TEXT,
    "waba_id" TEXT,
    "env_sufixo" TEXT NOT NULL,
    "dados_modelos" JSONB NOT NULL,
    "atualizado_por" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_chatwoot_pkey" PRIMARY KEY ("unit_id")
);

CREATE TABLE IF NOT EXISTS "unit_chatwoot_caixa" (
    "caixa_id" INTEGER NOT NULL,
    "unit_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "instancia_evolution" TEXT,

    CONSTRAINT "unit_chatwoot_caixa_pkey" PRIMARY KEY ("caixa_id")
);

CREATE INDEX IF NOT EXISTS "unit_chatwoot_caixa_unit_id_idx" ON "unit_chatwoot_caixa"("unit_id");

ALTER TABLE "unit_chatwoot" ADD CONSTRAINT "unit_chatwoot_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_chatwoot_caixa" ADD CONSTRAINT "unit_chatwoot_caixa_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit_chatwoot"("unit_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SEMENTE: Parauapebas, com exatamente os valores que estavam escritos no código (ids da conta 1 do Chatwoot).
-- Só entra se a unidade existe; se já houver linha, não mexe (ON CONFLICT DO NOTHING).
INSERT INTO "unit_chatwoot" ("unit_id", "prefixo_modelos", "usuario_celular_id", "gerente_id", "meta_agendamentos_dia", "kapso_phone_number_id", "waba_id", "env_sufixo", "dados_modelos", "atualizado_por", "atualizado_em")
SELECT u."id", 'parau_', 7, 4, 5, '1212928641906230', '2146287749563217', 'PARAUAPEBAS',
       '{"nome":"Doutor Hérnia Parauapebas","cidade":"Parauapebas","endereco":"Rua C, 455-A, Sala 101 e 103 — Cidade Nova, Parauapebas/PA, 68515-000","mapa":"https://share.google/LzWt0AQhG4HWTpWOq"}'::jsonb,
       'migration 20261114120000', CURRENT_TIMESTAMP
FROM "units" u WHERE u."slug" = 'doutor-hernia-parauapebas'
ON CONFLICT ("unit_id") DO NOTHING;

INSERT INTO "unit_chatwoot_caixa" ("caixa_id", "unit_id", "tipo", "instancia_evolution")
SELECT v."caixa_id", u."id", v."tipo", v."instancia"
FROM "units" u
JOIN (VALUES (2, 'evolution', 'parauapebas-unidade'), (3, 'cloud', NULL), (4, 'historico', NULL)) AS v("caixa_id", "tipo", "instancia") ON TRUE
WHERE u."slug" = 'doutor-hernia-parauapebas'
  AND EXISTS (SELECT 1 FROM "unit_chatwoot" c WHERE c."unit_id" = u."id")
ON CONFLICT ("caixa_id") DO NOTHING;
