-- Nome da IA por horário (Tatuí: Sara/Cíntia). Coluna nova, nula e sem default: nenhuma unidade muda até alguém gravar a escala. Migration aditiva.
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "persona_agent_name_schedule" JSONB;
