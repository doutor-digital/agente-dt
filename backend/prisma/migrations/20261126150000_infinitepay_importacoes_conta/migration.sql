-- Conta do arquivo importado (HMAC com segredo do servidor + 4 últimos caracteres) e índices por sha256 e por conta, para recusar o mesmo arquivo em outra unidade e o extrato de outra conta (26/11/2026).
-- Colunas novas e nulas, índice novo: nada existente muda.
ALTER TABLE "infinitepay_importacoes" ADD COLUMN "conta_hash" TEXT, ADD COLUMN "conta_final" TEXT;

CREATE INDEX "infinitepay_importacoes_sha256_idx" ON "infinitepay_importacoes"("sha256");

CREATE INDEX "infinitepay_importacoes_conta_hash_idx" ON "infinitepay_importacoes"("conta_hash");
