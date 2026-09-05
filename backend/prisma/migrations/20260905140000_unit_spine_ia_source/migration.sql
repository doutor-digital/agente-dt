-- Origem "IA SOFIA" na franquia (idSource 10002, criada pela franquia nas 10 unidades em
-- 05/09/2026). A Sofia passa a gravá-la ao cadastrar/converter o paciente que vai agendar.
-- A API da franquia não tem rota de atualização (PUT/PATCH em /api/clients e /api/leads
-- devolvem "Cannot PUT"), então a origem só entra na criação — por isso a opção separada
-- para o LEAD espelhado, que nasce antes de sabermos se o paciente vai marcar.
ALTER TABLE "units"
  ADD COLUMN "spine_ia_source_id"    INTEGER,
  ADD COLUMN "spine_ia_source_leads" BOOLEAN NOT NULL DEFAULT false;
