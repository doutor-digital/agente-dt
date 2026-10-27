/**
 * A chave do contador de rodadas com limite de taxa: o NÚMERO de WhatsApp (phone_number_id), porque a restrição e o limite da
 * Meta são do número, não da unidade. Duas unidades que dividem o número (Petrópolis e Caxias) contam juntas. Sem número
 * cadastrado, a própria unidade.
 */
export function chaveDoLimite(unit: { id: string; metaPhoneNumberId?: string | null }): string {
  const numero = unit.metaPhoneNumberId?.trim();
  return numero ? `numero:${numero}` : `unidade:${unit.id}`;
}
