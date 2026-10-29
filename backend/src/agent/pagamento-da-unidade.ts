/**
 * Unidade SEM pagamento antecipado (Timbó: só paga no dia, na clínica).
 *
 * Até 29/10/2026 o agente tratava TODA unidade como se tivesse Pix antecipado: `agendar_consulta` recusava marcar até
 * o paciente escolher "Pix antecipado ou na clínica", a confirmação dizia "a equipe envia a chave do PIX para
 * garantir a vaga" e a régua de follow-up cobrava o Pix. O prompt de Timbó dizia o contrário, mas as instruções do
 * código vêm depois e ganham. Esta é a ÚNICA decisão: todo ponto do código que fala de antecipado pergunta aqui.
 *
 * Campo `Unit.acceptsAdvancePayment` (padrão true: nenhuma outra unidade muda). Com false:
 *  - nunca se pergunta a forma de pagamento (é "na clínica", implícito);
 *  - nunca se fala de antecipado, de chave Pix para reservar, nem de desconto por pagar antes.
 *
 * Combinação com `spineBookingRequiresPayment` (taxa de reserva obrigatória, Boa Vista): são incompatíveis — a taxa É um
 * pagamento antecipado, e a trava de reserva (grafo) exige o comprovante. A taxa VENCE: com as duas ligadas a unidade
 * se comporta como Boa Vista de hoje, e a flag nova é ignorada (com aviso no log, uma vez por unidade). É o lado
 * seguro: ignorar a taxa liberaria marcar sem pagamento numa unidade que o exige.
 */
import { logger } from '../lib/logger.js';

export interface FlagsDePagamento {
  acceptsAdvancePayment?: boolean | null;
  spineBookingRequiresPayment?: boolean | null;
  slug?: string | null;
}

const avisadas = new Set<string>();

/** true = esta unidade só recebe no dia, na clínica: o agente nunca fala de antecipado. */
export function unidadeSemAntecipado(unit: FlagsDePagamento | null | undefined): boolean {
  // Só `false` explícito desliga. Unidade de teste sem o campo, linha antiga, undefined: tudo como hoje.
  if (!unit || unit.acceptsAdvancePayment !== false) return false;
  if (unit.spineBookingRequiresPayment) {
    const chave = unit.slug ?? '?';
    if (!avisadas.has(chave)) {
      avisadas.add(chave);
      logger.warn(
        { unit: chave },
        'pagamento: acceptsAdvancePayment=false junto com spineBookingRequiresPayment=true — a taxa de reserva vence, a flag é ignorada',
      );
    }
    return false;
  }
  return true;
}

/** Como se paga nessas unidades — a frase da confirmação e a resposta a "como pago?". */
export const PAGAMENTO_NO_DIA = 'O pagamento é feito no dia, na clínica (dinheiro, pix, cartão de débito ou crédito).';

/** A regra que fecha a porta para o modelo (sem a palavra do conceito proibido: o teste do prompt checa que ela não aparece). */
export const REGRA_SEM_ANTECIPADO =
  'A consulta é paga no dia, na clínica. NUNCA fale em pagar antes da consulta, em Pix para reservar a vaga, em chave Pix nem em desconto.';
