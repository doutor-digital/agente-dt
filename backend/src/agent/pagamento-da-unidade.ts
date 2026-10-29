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
 * se comporta como Boa Vista de hoje, e a flag nova é ignorada (o PATCH da unidade avisa no log). É o lado
 * seguro: ignorar a taxa liberaria marcar sem pagamento numa unidade que o exige.
 */
export interface FlagsDePagamento {
  acceptsAdvancePayment?: boolean | null;
  spineBookingRequiresPayment?: boolean | null;
}

/**
 * true = esta unidade só recebe no dia, na clínica: o agente nunca fala de antecipado.
 * Função PURA (é chamada várias vezes por turno, do prompt ao guardrail): a combinação inválida das duas flags é
 * avisada onde a unidade é salva (units.controller), não aqui.
 */
export function unidadeSemAntecipado(unit: FlagsDePagamento | null | undefined): boolean {
  // Só `false` explícito desliga. Unidade de teste sem o campo, linha antiga, undefined: tudo como hoje.
  if (!unit || unit.acceptsAdvancePayment !== false) return false;
  // A taxa de reserva obrigatória é um pagamento antecipado: ela vence.
  return !unit.spineBookingRequiresPayment;
}

/**
 * O degrau da régua de follow-up para uma unidade sem antecipado: sai a frase que vende o antecipado.
 *
 * Os degraus são texto genérico da rede (e cópias editáveis no banco). O único que fala de antecipado fora da escada do
 * Pix é o PERDIDO "Achou caro" ("Termine oferecendo o antecipado de R$ 150"). Em vez de só pedir ao modelo que ignore a
 * frase, ela é tirada do texto que ele recebe. Frases de PROIBIÇÃO ("NÃO fale em Pix…") ficam. Nas demais unidades:
 * o mesmo texto, sem tocar.
 */
export function intencaoDoDegrauParaAUnidade(intencao: string, unit: FlagsDePagamento | null | undefined): string {
  if (!unidadeSemAntecipado(unit)) return intencao;
  return intencao
    .split(/(?<=[.!?])\s+/)
    .filter((frase) => !/antecipad|\bpix\b/i.test(frase) || /^(?:n[ãa]o|nunca|sem)\b/i.test(frase.trim()))
    .join(' ');
}

/** Como se paga nessas unidades — a frase da confirmação e a resposta a "como pago?". */
export const PAGAMENTO_NO_DIA = 'O pagamento é feito no dia, na clínica (dinheiro, pix, cartão de débito ou crédito).';

/** A regra que fecha a porta para o modelo (sem a palavra do conceito proibido: o teste do prompt checa que ela não aparece). */
export const REGRA_SEM_ANTECIPADO =
  'A consulta é paga no dia, na clínica. NUNCA fale em pagar antes da consulta, em Pix para reservar a vaga, em chave Pix nem em desconto.';
