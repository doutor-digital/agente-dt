-- Nome da IA por unidade (ex: Salto → "Aline"). Coluna nova e vazia: todas as unidades seguem "Sofia". Aditiva.
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_agent_name" TEXT;
