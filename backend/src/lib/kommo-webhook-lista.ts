/**
 * Lista do webhook do Kommo, do jeito que o Express entrega.
 *
 * O Kommo manda o corpo em form-urlencoded (`leads[status][0][id]=…`). O `express.urlencoded({ extended:
 * true })` usa o `qs`, que só monta ARRAY até o índice 20 (`arrayLimit`): de `leads[status][21]` em diante
 * o mesmo campo chega como OBJETO `{ "0": …, "1": …, "21": … }`. Com o `z.array` direto, o webhook inteiro
 * voltava 400 — e o Kommo desliga o webhook que falha seguidas vezes. Mudança de etapa em lote (a franquia
 * movendo dezenas de cartões, a SDR arrastando vários) é exatamente o caso em que isso aparece, e o evento
 * `status_lead` (carimbo de etapa) passa a chegar na conta da Açailândia em 16/10/2026.
 *
 * Objeto com chaves numéricas vira array na ordem dos índices; qualquer outra coisa passa intacta (o zod
 * decide). Item único sem índice (`leads[status][id]=…`) vira lista de um.
 */
export function listaDoKommo(v: unknown): unknown {
  if (v === undefined || v === null || Array.isArray(v) || typeof v !== 'object') return v;
  const chaves = Object.keys(v as Record<string, unknown>);
  if (chaves.length === 0) return [];
  if (chaves.every((k) => /^\d+$/.test(k))) {
    return chaves
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => (v as Record<string, unknown>)[String(k)]);
  }
  // `leads[status][id]=1` sem índice: um item só.
  if ('id' in (v as Record<string, unknown>)) return [v];
  return v;
}
