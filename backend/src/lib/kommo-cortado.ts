/**
 * Unidade que SAIU da Kommo: o número de WhatsApp foi para a Kapso e quem atende é o CRM (Chatwoot). Pedido do João em 25/11/2026,
 * no corte de Timbó.
 *
 * A Sofia do CRM e a régua não falam com paciente que tem cartão ATIVO no Kommo da unidade (decisão 31: «duas Sofias falando com a
 * mesma pessoa é o pior dos mundos»). Depois do corte, a Kommo não recebe nem manda mais nada, mas os cartões continuam abertos lá.
 * Sem esta chave, a Sofia do CRM ficaria calada com quase todo paciente atual da unidade.
 *
 * A credencial da Kommo continua na unidade (o importador do histórico e os relatórios ainda leem de lá): por isso a trava é uma
 * chave própria, e não «unidade sem token».
 *
 * Env: `CHATWOOT_KOMMO_CORTADO_SLUGS` — slugs separados por vírgula (ex.: `doutor-hernia-timbo`). Vazio = nenhuma unidade cortada.
 */
export function kommoCortado(slug: string | null | undefined, lista: string | undefined = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS): boolean {
  if (!slug || !lista) return false;
  return lista
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(slug.trim());
}

/**
 * A Sofia do CRM e a régua devem conferir «cartão ATIVO no Kommo» desta unidade? Só se ela tem Kommo configurado E não foi cortada.
 * Usada nos dois lugares (chatwoot-ia.ts e chatwoot-regua-worker.ts) para a regra não divergir.
 */
export function confereCartaoNoKommo(
  unit: { slug: string; kommoSubdomain?: string | null; kommoAccessToken?: string | null },
  lista: string | undefined = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS,
): boolean {
  return !!unit.kommoSubdomain && !!unit.kommoAccessToken && !kommoCortado(unit.slug, lista);
}
