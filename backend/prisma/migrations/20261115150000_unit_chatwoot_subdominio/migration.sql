-- Subdomínio do CRM da clínica (nullable, sem default: ALTER instantâneo, nada a preencher). Parauapebas fica null = só a origem principal.
ALTER TABLE "unit_chatwoot" ADD COLUMN "subdominio" TEXT;
