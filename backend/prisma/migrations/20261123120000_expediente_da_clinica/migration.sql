-- Expediente da clínica (quando a EQUIPE atende; a IA atende o resto, com precisão de minuto).
-- Coluna nova e nula: nenhuma unidade muda de comportamento até alguém gravar um valor.
ALTER TABLE "units" ADD COLUMN "business_hours_expediente" JSONB;
