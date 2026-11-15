-- Uma conta do Chatwoot por clínica (15/11/2026) — passo 1: o banco.
--
-- 1) unit_chatwoot.conta_id: a conta do Chatwoot da unidade. NULL = a conta do ambiente (CHATWOOT_CONTA_ID, a 1 de Parauapebas):
--    coluna nova, nula, sem valor padrão — nenhuma linha existente muda.
-- 2) chatwoot_regua_disparo: a chave única passa de (conversation_id, regra, chave) para (caixa, conversation_id, regra, chave).
--    O conversation_id da API do Chatwoot é POR CONTA; a caixa (inbox) é única na instalação. Sem isto, a conversa 5 da conta 1 e a
--    conversa 5 da conta 2 colidiriam e a segunda nunca receberia a mesma regra.
--    A chave NOVA é mais larga que a antiga (tem uma coluna a mais): quem já cumpre a antiga cumpre a nova, então não existe duplicata
--    possível e a criação do índice não pode falhar por dado. O índice novo nasce ANTES de o antigo cair (nunca fica sem proteção),
--    na mesma transação. A tabela é pequena (uma linha por mensagem/nota decidida da régua): o bloqueio de escrita dura milissegundos.
CREATE UNIQUE INDEX IF NOT EXISTS "chatwoot_regua_disparo_caixa_conversation_id_regra_chave_key"
  ON "chatwoot_regua_disparo" ("caixa", "conversation_id", "regra", "chave");

DROP INDEX IF EXISTS "chatwoot_regua_disparo_conversation_id_regra_chave_key";

ALTER TABLE "unit_chatwoot" ADD COLUMN IF NOT EXISTS "conta_id" INTEGER;
