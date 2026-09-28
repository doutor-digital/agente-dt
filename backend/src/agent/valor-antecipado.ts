/**
 * O NÚMERO NO LUGAR DO ANTECIPADO TEM DE SER O ANTECIPADO DA UNIDADE.
 *
 * Pedido do gestor da Serra em 26/09/2026, pela segunda vez no mês: "favor corrigir a IA pq
 * continua enviando preços errados". A tabela certa da Serra é
 *
 *     particular: R$ 350 no dia · R$ 280 antecipado
 *     com plano:  R$ 250 no dia · R$ 220 antecipado
 *
 * e a IA anunciava "R$ 250 antecipado" para paciente particular — R$ 70 a menos, prometido
 * por escrito no WhatsApp.
 *
 * POR QUE O GUARDRAIL DE PREÇO NÃO PEGA: ele confere se o número EXISTE no catálogo da ficha,
 * não se é o número certo para aquele lugar da frase. E R$ 250 existe: é o valor de quem tem
 * plano pagando no dia. Então "R$ 250 antecipado" passa limpo — foi medido, passa mesmo.
 * Essa é a diferença entre um valor inventado (o guardrail resolve) e um valor real usado no
 * slot errado (só isto resolve).
 *
 * O MESMO ERRO EM OUTRAS UNIDADES: a Boa Vista já anunciou "R$ 450 ou R$ 100" porque 450 saiu
 * de uma NEGAÇÃO na ficha, e a Serra já trocou 280 por 250 antes. O padrão é sempre o mesmo —
 * a ficha tem vários números, o modelo escolhe o errado para o slot do antecipado.
 *
 * ── O QUE NÃO ENTRA, e é o cuidado que importa ────────────────────────────────────────────
 * 1. MENSAGEM QUE FALA DE PLANO/CONVÊNIO SAI INTEIRA. Lição que já custou caro em
 *    `preco-convenio.ts`: corrigir frase por frase fez a IA AUMENTAR o preço de quem tem
 *    plano. Se o plano aparece em qualquer lugar da mensagem, esta trava não toca em nada —
 *    ali o dono é o fluxo de convênio.
 * 2. UNIDADE COM TAXA DE RESERVA SAI INTEIRA (`spineBookingRequiresPayment`, Boa Vista). Lá o
 *    antecipado é PARTE do valor do dia, não alternativa: "R$ 100 antecipado + R$ 250 no dia"
 *    está certo e trocar o 100 por 350 seria o desastre.
 */

/** Marcadores de que o R$ anterior é o valor do pagamento antecipado. */
const MARCA_ANTECIPADO =
  '(?:antecipad[ao]|pagando\\s+antes|pagar\\s+antes|paga\\s+antes|antes\\s+por\\s+(?:pix|p[ií]x)|por\\s+pix\\s+antes|com\\s+anteced[êe]ncia)';

/** Se isto aparece na mensagem, o assunto é plano de saúde e a trava não opina. */
const FALA_DE_PLANO = /\b(plano\s+de\s+sa[úu]de|conv[êe]nio|carteirinha|unimed|amil|bradesco\s+sa[úu]de|hapvida|ipasgo|cassi|geap)\b/i;

export interface OpcoesAntecipado {
  /** O valor antecipado oficial da unidade, de `precosDaConsulta`. */
  antecipado: number;
  /** Unidade com taxa de reserva obrigatória — a trava não vale lá. */
  taxaDeReserva?: boolean;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));
const paraNumero = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));

export function corrigirValorAntecipado(
  texto: string,
  { antecipado, taxaDeReserva = false }: OpcoesAntecipado,
): { texto: string; corrigiu: number[] } {
  if (!texto || !Number.isFinite(antecipado) || antecipado <= 0) return { texto, corrigiu: [] };
  if (taxaDeReserva) return { texto, corrigiu: [] };
  // Bail de mensagem inteira, não de frase. Ver nota 1 no topo.
  if (FALA_DE_PLANO.test(texto)) return { texto, corrigiu: [] };

  // R$ X ... <marca de antecipado>, sem outro R$ no meio — senão "R$ 350 no dia, ou R$ 250
  // antecipado" casaria com o 350.
  const re = new RegExp(
    `R\\$\\s?(\\d{2,4}(?:[.,]\\d{2})?)((?:(?!R\\$)[^\\n.;)]){0,45}?${MARCA_ANTECIPADO})`,
    'gi',
  );

  const corrigiu: number[] = [];
  const saida = texto.replace(re, (todo, valor: string, meio: string, posicao: number) => {
    const v = paraNumero(valor);
    if (!Number.isFinite(v) || v === antecipado) return todo;
    // Parcelamento não é o valor da consulta: "3x de R$ 100" não vira "3x de R$ 280".
    // O "3x de" está ANTES do match, então tem de vir do texto original pela posição —
    // olhar dentro de `todo` não enxerga nada (ele começa no "R$").
    const antes = texto.slice(Math.max(0, posicao - 14), posicao);
    if (/\d\s*x\s*(?:de\s*)?$/i.test(antes)) return todo;
    corrigiu.push(v);
    return `R$ ${fmt(antecipado)}${meio}`;
  });

  return { texto: saida, corrigiu };
}
