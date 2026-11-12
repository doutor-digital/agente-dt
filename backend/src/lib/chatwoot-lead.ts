/**
 * A "chave de lead" da conversa do Chatwoot.
 *
 * As ferramentas reais da Sofia (agenda, cadastro, sinal Pix) guardam tudo por `leadId` do Kommo: `spine_lead_links.kommo_lead_id`
 * (INT), `sinais_pix.lead_id` (texto). A conversa do Chatwoot não tem lead no Kommo, então ganha uma chave sintética numa faixa
 * RESERVADA: `BASE + id da conversa`. Os ids do Kommo estão na casa dos 30 milhões e crescem ~1 milhão por mês; a faixa começa em
 * 2 bilhões (o INT do Postgres vai a 2,147 bilhões) e deixa ~147 milhões de conversas. Não colide com cartão do Kommo, e dá para
 * reconhecer de longe: quem lê a tabela e vai ao Kommo com esse id (lembretes, baixa do sinal) pergunta `ehLeadDoChatwoot` antes.
 *
 * Sem migration e sem coluna nova. O preço: essas linhas aparecem nas telas que listam vínculos (com o id enorme) e as rotinas do Kommo
 * têm de pular a faixa — hoje o lembrete da véspera (reminder-worker) e a baixa do sinal (sinal-pix-worker, que baixa no Chatwoot).
 */
export const BASE_LEAD_CHATWOOT = 2_000_000_000;
const MAX_INT4 = 2_147_483_647;

/** A chave sintética da conversa; lança se a conversa não cabe na faixa. */
export function leadDaConversaChatwoot(conversa: number): number {
  if (!Number.isInteger(conversa) || conversa <= 0 || BASE_LEAD_CHATWOOT + conversa > MAX_INT4) {
    throw new Error(`conversa do Chatwoot fora da faixa reservada: ${conversa}`);
  }
  return BASE_LEAD_CHATWOOT + conversa;
}

export function ehLeadDoChatwoot(leadId: number): boolean {
  return Number.isInteger(leadId) && leadId >= BASE_LEAD_CHATWOOT && leadId <= MAX_INT4;
}

/** O id da conversa a partir da chave sintética; null se a chave é de um cartão do Kommo. */
export function conversaDoLeadChatwoot(leadId: number): number | null {
  return ehLeadDoChatwoot(leadId) ? leadId - BASE_LEAD_CHATWOOT : null;
}

/**
 * Para as rotinas que vão do vínculo ao CARTÃO do Kommo (lembrete da véspera, sincronizador da franquia): ignora as chaves sintéticas.
 * Uso: `where: { ...SO_CARTAO_DO_KOMMO, … }`.
 */
export const SO_CARTAO_DO_KOMMO = { kommoLeadId: { lt: BASE_LEAD_CHATWOOT } } as const;
