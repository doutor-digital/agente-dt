-- Allowlist de etapas em que a IA pode responder. Lista vazia (default) mantém
-- o comportamento atual: a IA responde em qualquer etapa. Quando preenchida, o
-- guard do webhook só deixa o agente responder se o lead estiver numa dessas
-- etapas (status_id); nas demais (ex: agendado, em tratamento) fica em silêncio.
ALTER TABLE "units" ADD COLUMN "kommo_allowed_status_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
