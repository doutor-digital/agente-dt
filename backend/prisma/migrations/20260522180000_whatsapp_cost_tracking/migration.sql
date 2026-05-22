-- WhatsApp Cost Tracking — pricing_analytics + template_analytics da Meta.
-- Adiciona campo WABA ID + orçamento mensal Meta na Unit + 2 tabelas de snapshot diário.
--
-- Modelagem: campos opcionais "country", "phone_number", "tier" ficam NOT NULL
-- com default '' em vez de NULL. Razão: Postgres trata NULL como distinto em
-- UNIQUE, o que quebra upsert idempotente do Prisma. String vazia = "dimensão
-- agregada/não-segmentada".

-- 1) Campos novos na Unit.
ALTER TABLE "units"
  ADD COLUMN "meta_waba_id"            TEXT,
  ADD COLUMN "meta_monthly_budget_usd" NUMERIC(10, 2) NOT NULL DEFAULT 0;

-- 2) Snapshot diário de custo via /pricing_analytics.
CREATE TABLE "whatsapp_cost_daily" (
  "id"               TEXT NOT NULL,
  "unit_id"          TEXT NOT NULL,
  "date"             DATE NOT NULL,
  "pricing_category" TEXT NOT NULL,
  "pricing_type"     TEXT NOT NULL DEFAULT 'REGULAR',
  "country"          TEXT NOT NULL DEFAULT '',
  "phone_number"     TEXT NOT NULL DEFAULT '',
  "tier"             TEXT NOT NULL DEFAULT '',
  "volume"           INTEGER NOT NULL DEFAULT 0,
  "cost_usd"         NUMERIC(12, 6) NOT NULL DEFAULT 0,
  "currency"         TEXT NOT NULL DEFAULT 'USD',
  "synced_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_cost_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_cost_daily_uniq" ON "whatsapp_cost_daily" (
  "unit_id",
  "date",
  "pricing_category",
  "pricing_type",
  "country",
  "phone_number",
  "tier"
);

CREATE INDEX "whatsapp_cost_daily_unit_date_idx" ON "whatsapp_cost_daily" ("unit_id", "date" DESC);
CREATE INDEX "whatsapp_cost_daily_date_idx"      ON "whatsapp_cost_daily" ("date" DESC);

ALTER TABLE "whatsapp_cost_daily"
  ADD CONSTRAINT "whatsapp_cost_daily_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) Snapshot diário por template via /template_analytics.
CREATE TABLE "whatsapp_template_daily" (
  "id"            TEXT NOT NULL,
  "unit_id"       TEXT NOT NULL,
  "date"          DATE NOT NULL,
  "template_id"   TEXT NOT NULL,
  "template_name" TEXT,
  "language"      TEXT NOT NULL DEFAULT '',
  "sent"          INTEGER NOT NULL DEFAULT 0,
  "delivered"     INTEGER NOT NULL DEFAULT 0,
  "read"          INTEGER NOT NULL DEFAULT 0,
  "clicked"       INTEGER NOT NULL DEFAULT 0,
  "cost_usd"      NUMERIC(12, 6) NOT NULL DEFAULT 0,
  "currency"      TEXT NOT NULL DEFAULT 'USD',
  "synced_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_template_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_template_daily_uniq" ON "whatsapp_template_daily" (
  "unit_id",
  "date",
  "template_id",
  "language"
);

CREATE INDEX "whatsapp_template_daily_unit_date_idx" ON "whatsapp_template_daily" ("unit_id", "date" DESC);
CREATE INDEX "whatsapp_template_daily_date_idx"      ON "whatsapp_template_daily" ("date" DESC);

ALTER TABLE "whatsapp_template_daily"
  ADD CONSTRAINT "whatsapp_template_daily_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
