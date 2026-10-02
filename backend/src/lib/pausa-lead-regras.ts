/** Regras puras da pausa por lead (sem banco nem Kommo — testáveis). Ver `pausa-lead.ts`. */

export const PAUSA_LEAD_MAX_DIAS = 30;

export interface JanelaDoLead {
  ate: Date;
}

/** Vale agora? A linha só existe enquanto a pausa é futura, mas o worker leva até 1 min para limpar. */
export function pausaDoLeadAtiva(p: JanelaDoLead | null | undefined, agora: Date = new Date()): boolean {
  return !!p && agora < p.ate;
}

/** Regras do pedido: fim no futuro e no máximo 30 dias. */
export function validarPausaDoLead(ate: Date, agora: Date = new Date()): string | null {
  if (Number.isNaN(ate.getTime())) return 'data de retorno inválida';
  if (ate <= agora) return 'a data de retorno precisa estar no futuro';
  if (ate.getTime() - agora.getTime() > PAUSA_LEAD_MAX_DIAS * 86_400_000) {
    return `a pausa de um lead vai até ${PAUSA_LEAD_MAX_DIAS} dias`;
  }
  return null;
}
