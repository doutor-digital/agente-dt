/**
 * Lista do webhook do Kommo, tolerante ao formato que o parser entrega.
 *
 * CORRIGIDO na revisão de 16/10/2026: com o Express 5 / body-parser 2.2.2 deste servidor a lista JÁ chega
 * como array em qualquer tamanho (o `qs` do body-parser não corta em 20 índices). O limite que derrubava o
 * webhook do `status_lead` era outro — o `parameterLimit` de 1000, que devolve 413 antes do handler —, e
 * quem resolve é o parser próprio da rota (`parser-webhook-kommo.ts`).
 *
 * Isto fica como defesa barata, para o caso de o parser mudar: objeto com chaves numéricas vira array na
 * ordem dos índices; item único sem índice (`leads[status][id]=…`) vira lista de um; o resto passa intacto
 * e o zod decide.
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
