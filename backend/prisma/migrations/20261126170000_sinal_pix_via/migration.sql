-- Sinal da Sofia 2.0 por link da InfinitePay (26/11/2026). Só ACRESCENTA uma coluna com padrão: toda linha existente (e toda nova do Pix do Asaas) segue 'asaas'.
ALTER TABLE "sinais_pix" ADD COLUMN "via" TEXT NOT NULL DEFAULT 'asaas';
