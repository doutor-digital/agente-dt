-- Subdomínio do CRM da clínica (nullable, sem default: ALTER instantâneo, nada a preencher). Parauapebas fica null = só a origem principal.
ALTER TABLE "unit_chatwoot" ADD COLUMN "subdominio" TEXT;

-- Parauapebas já tem o CRM em drherniaparauapebas.doutordigitalconsultoria.com e a equipe pode estar usando: grava o subdomínio só se estiver nulo (nunca troca um valor existente).
UPDATE "unit_chatwoot" SET "subdominio" = 'drherniaparauapebas'
WHERE "subdominio" IS NULL AND "unit_id" IN (SELECT "id" FROM "units" WHERE "slug" = 'doutor-hernia-parauapebas');
