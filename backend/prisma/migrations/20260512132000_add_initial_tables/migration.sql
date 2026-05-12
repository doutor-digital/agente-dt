-- CreateEnum
CREATE TYPE "TraceStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "StepKind" AS ENUM ('WEBHOOK_RECEIVED', 'THINKING', 'TOOL_CALL', 'TOOL_RESULT', 'KOMMO_ACTION', 'COMPLETED', 'ERROR');

-- CreateTable
CREATE TABLE "execution_traces" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "ia_decision" JSONB,
    "latency_ms" INTEGER,
    "status" "TraceStatus" NOT NULL DEFAULT 'RUNNING',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "execution_traces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_steps" (
    "id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "StepKind" NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkpoints" (
    "thread_id" TEXT NOT NULL,
    "checkpoint_ns" TEXT NOT NULL DEFAULT '',
    "checkpoint_id" TEXT NOT NULL,
    "parent_checkpoint_id" TEXT,
    "type" TEXT,
    "checkpoint" BYTEA NOT NULL,
    "metadata" BYTEA NOT NULL,

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("thread_id","checkpoint_ns","checkpoint_id")
);

-- CreateTable
CREATE TABLE "checkpoint_writes" (
    "thread_id" TEXT NOT NULL,
    "checkpoint_ns" TEXT NOT NULL DEFAULT '',
    "checkpoint_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT,
    "value" BYTEA,
    "task_path" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "checkpoint_writes_pkey" PRIMARY KEY ("thread_id","checkpoint_ns","checkpoint_id","task_id","idx")
);

-- CreateTable
CREATE TABLE "checkpoint_blobs" (
    "thread_id" TEXT NOT NULL,
    "checkpoint_ns" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "blob" BYTEA,

    CONSTRAINT "checkpoint_blobs_pkey" PRIMARY KEY ("thread_id","checkpoint_ns","channel","version")
);

-- CreateTable
CREATE TABLE "agent_configs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "system_prompt" TEXT NOT NULL,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "workflow" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "execution_traces_thread_id_idx" ON "execution_traces"("thread_id");

-- CreateIndex
CREATE INDEX "execution_traces_lead_id_idx" ON "execution_traces"("lead_id");

-- CreateIndex
CREATE INDEX "execution_traces_created_at_idx" ON "execution_traces"("created_at" DESC);

-- CreateIndex
CREATE INDEX "execution_steps_trace_id_idx" ON "execution_steps"("trace_id");

-- CreateIndex
CREATE UNIQUE INDEX "execution_steps_trace_id_sequence_key" ON "execution_steps"("trace_id", "sequence");

-- CreateIndex
CREATE INDEX "agent_configs_is_active_idx" ON "agent_configs"("is_active");

-- AddForeignKey
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_trace_id_fkey" FOREIGN KEY ("trace_id") REFERENCES "execution_traces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
