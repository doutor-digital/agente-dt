-- Modo prompt único: quando true, o systemPrompt da unidade é o prompt inteiro
-- e o composer não injeta os blocos auto-gerados (persona, regras, toggles,
-- fontes, ações, templates). Só os blocos de runtime (leadId, memória, RAG)
-- continuam sendo adicionados. Default false mantém o comportamento atual
-- (modo em camadas).
ALTER TABLE "units" ADD COLUMN "single_prompt_mode" BOOLEAN NOT NULL DEFAULT false;
