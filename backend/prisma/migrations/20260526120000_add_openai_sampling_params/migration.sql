-- Amostragem avançada por unidade: Top P + frequency/presence penalty.
-- Defaults reproduzem o comportamento atual (sem efeito): topP=1, penalties=0.
ALTER TABLE "units" ADD COLUMN "openai_top_p" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "units" ADD COLUMN "openai_frequency_penalty" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "units" ADD COLUMN "openai_presence_penalty" DOUBLE PRECISION NOT NULL DEFAULT 0;
