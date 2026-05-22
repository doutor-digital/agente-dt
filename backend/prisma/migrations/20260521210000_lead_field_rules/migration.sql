-- CreateTable
CREATE TABLE "lead_field_rules" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kommo_field_id" INTEGER NOT NULL,
    "kommo_field_name" TEXT NOT NULL,
    "kommo_field_type" TEXT NOT NULL,
    "kommo_field_enums" JSONB,
    "tool_name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "value_hint" TEXT,
    "examples" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_field_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_field_rules_unit_id_enabled_idx" ON "lead_field_rules"("unit_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "lead_field_rules_unit_id_tool_name_key" ON "lead_field_rules"("unit_id", "tool_name");

-- AddForeignKey
ALTER TABLE "lead_field_rules" ADD CONSTRAINT "lead_field_rules_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
