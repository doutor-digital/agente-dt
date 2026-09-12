-- Cartão de chegada (foto da fachada + endereço + mapa) depois do agendamento.
ALTER TABLE "units" ADD COLUMN "clinic_map_url" TEXT;
ALTER TABLE "units" ADD COLUMN "clinic_photo_drive_uuid" TEXT;
ALTER TABLE "units" ADD COLUMN "clinic_photo_drive_version" TEXT;
