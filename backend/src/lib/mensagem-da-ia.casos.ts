/**
 * Tabela de casos da regra "mensagem da IA" (`mensagem-da-ia.ts`): meta -> [é da IA?, é a Sofia conversando?].
 * Usada pelo teste puro (`mensagem-da-ia.test.ts`) e pelo teste de SQL (`qualidade-ia/consulta.sql.test.ts`),
 * para o JavaScript e o SQL serem cobrados pela MESMA lista de exemplos.
 */
export const CASOS_DE_META: ReadonlyArray<readonly [unknown, boolean, boolean]> = [
  [null, true, true],
  [{}, true, true],
  [{ via: 'salesbot' }, true, true],
  [{ via: 'meta', messageId: 'x' }, true, true],
  [{ via: 'widget_request' }, true, true],
  [{ origem: 'kommo_talks', autor: 'equipe' }, false, false],
  [{ origem: 'kommo_talks' }, false, false],
  [{ origem: 'backfill-kommo' }, false, false],
  [{ autor: 'equipe' }, false, false],
  [{ origem: 'confirmacao_d1', via: 'salesbot' }, false, false],
  [{ origem: 'confirmacao_d2' }, false, false],
  [{ via: 'chat_cartao', comFoto: true }, false, false],
  [{ via: 'lead_note' }, false, false],
  // da IA, mas envio automático: o resumo não chama de "Sofia conversando"
  [{ followUp: 2 }, true, false],
  [{ reactivation: 1 }, true, false],
  [{ origem: 'lembrete_kommo' }, true, false],
  [{ followUp: null }, true, true],
];
