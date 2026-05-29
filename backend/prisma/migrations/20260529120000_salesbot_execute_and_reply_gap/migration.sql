-- Modo /execute (opt-in por unidade) do caminho legado: além do PATCH no campo
-- "Resposta IA", dispara o Salesbot explicitamente via POST /api/v4/bots/{id}/run
-- (recomendação do suporte do Kommo contra o anti-loop). Ao ligar, o gatilho
-- de "campo mudou" do Digital Pipeline deve ser DESLIGADO na unidade.
ALTER TABLE "units" ADD COLUMN "kommo_salesbot_execute_enabled" BOOLEAN NOT NULL DEFAULT false;
-- Intervalo mínimo (segundos) entre duas respostas no mesmo lead — trava
-- anti-loop. 0 = desligado. Defaults mantêm o comportamento atual.
ALTER TABLE "units" ADD COLUMN "persona_min_reply_gap_sec" INTEGER NOT NULL DEFAULT 0;
