-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('WARN', 'ERROR', 'FATAL');

-- CreateTable
CREATE TABLE "system_logs" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "module" TEXT,
    "msg" TEXT NOT NULL,
    "context" JSONB,
    "unit_id" TEXT,
    "trace_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_logs_created_at_idx" ON "system_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "system_logs_level_idx" ON "system_logs"("level");

-- CreateIndex
CREATE INDEX "system_logs_unit_id_idx" ON "system_logs"("unit_id");

-- CreateIndex
CREATE INDEX "system_logs_module_idx" ON "system_logs"("module");

-- AddForeignKey
ALTER TABLE "system_logs" ADD CONSTRAINT "system_logs_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_logs" ADD CONSTRAINT "system_logs_trace_id_fkey" FOREIGN KEY ("trace_id") REFERENCES "execution_traces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
