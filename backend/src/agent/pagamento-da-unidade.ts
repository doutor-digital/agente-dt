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
  /** Sofia 2.0: centavos do sinal por Pix (5000 = R$ 50); nulo/ausente = a unidade segue como sempre. Ver `unidadeComSinal`. */
  sinalPixCentavos?: number | null;
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
 * A unidade trabalha com SINAL por Pix (Sofia 2.0, 10/11/2026)? Campo `Unit.sinalPixCentavos` (nulo = como sempre): a consulta é
 * "R$ 350 no dia" ou "R$ 250 garantindo com sinal" (R$ 50 agora, por um Pix gerado pela Sofia no Asaas da unidade, + R$ 200 no
 * dia). Só a FLAG; os valores saem das fontes da unidade (`sinalDaUnidade`, em prompt-composer.ts). Função PURA.
 *
 * Mesma regra de precedência da taxa: unidade sem antecipado (Timbó) e unidade com taxa de reserva obrigatória (Boa Vista) ignoram o
 * sinal — o lado seguro, igual ao de `unidadeSemAntecipado`.
 */
export function unidadeComSinal(unit: FlagsDePagamento | null | undefined): boolean {
  if (!unit) return false;
  const c = unit.sinalPixCentavos;
  if (typeof c !== 'number' || !Number.isInteger(c) || c <= 0) return false;
  if (unit.acceptsAdvancePayment === false || unit.spineBookingRequiresPayment) return false;
  return true;
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
  // Sinal por Pix (Sofia 2.0): a chave e o "antecipado de R$ 150" dos degraus não existem lá; `regraDePagamento` (follow-up.ts) diz o que vale.
  if (!unidadeSemAntecipado(unit) && !unidadeComSinal(unit)) return intencao;
  return intencao
    .split(/(?<=[.!?])\s+/)
    .filter((frase) => !/antecipad|\bpix\b/i.test(frase) || /^(?:n[ãa]o|nunca)\b/i.test(frase.trim()))
    .join(' ');
}

/** Como se paga nessas unidades — a frase da confirmação e a resposta a "como pago?". */
export const PAGAMENTO_NO_DIA = 'O pagamento é feito no dia, na clínica (dinheiro, pix, cartão de débito ou crédito).';

/** A regra que fecha a porta para o modelo (sem a palavra "antecipad": o teste do prompt checa que ela não aparece). */
export const REGRA_SEM_ANTECIPADO =
  'A consulta é paga no dia, na clínica. NUNCA fale em pagar antes da consulta, em Pix para reservar a vaga, em enviar chave Pix nem em desconto.';

// ---------------------------------------------------------------------------------------------------------------------
// A mensagem de confirmação de uma unidade sem antecipado (formato pedido pelo João em 03/11/2026)
// ---------------------------------------------------------------------------------------------------------------------

/** Como se paga, DENTRO da linha do valor da confirmação (sem o parágrafo à parte que existia até 03/11/2026). */
export const FORMAS_NO_DIA = 'dinheiro, pix, cartão de débito ou crédito';

/** ☺ + seletor de variação 16: sem o U+FE0F o WhatsApp mostra o glifo preto e branco (ver carinha-antiga.ts). Os dois são BMP. */
export const SORRISO_DA_CONFIRMACAO = '☺️';

/**
 * O valor da consulta NO DIA, lido das fontes da unidade ("250,00"), ou null se não achar.
 *
 * Nada de número no código: é o primeiro R$ que vem logo depois da palavra "consulta", dentro da mesma frase. Se entre as duas
 * há "retorno", "sessão" ou "tratamento" ("Consulta de retorno: R$ 100"), é o valor de outro produto e não vale. Sem match, o
 * prompt manda o modelo ler as fontes.
 */
export function valorDaConsultaNoDia(sourceProdutos: string | null | undefined): string | null {
  const re = /consulta([^\n.;]{0,100}?)R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/gi;
  for (const m of (sourceProdutos ?? '').matchAll(re)) {
    if (/retorno|sess[ãõ]|tratamento/i.test(m[1])) continue;
    // sobra de ficha antiga ("R$ 250 antecipado ou R$ 350 no dia"): o valor colado em "antecipado"/"à vista" não é o do dia
    const depois = (sourceProdutos ?? '').slice((m.index ?? 0) + m[0].length).split(/R\$|[\n.;]/)[0].slice(0, 40);
    if (/antecipad|(?<!\p{L})à vista/iu.test(depois)) continue;
    const n = Number(`${m[2].replace(/\./g, '')}.${(m[3] ?? '0').padEnd(2, '0')}`);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n.toFixed(2).replace('.', ',');
  }
  return null;
}
