/**
 * "R$ 250 GARANTINDO COM SINAL DE R$ 50": O NÚMERO DESSE LUGAR É O ANTECIPADO DA UNIDADE — NÃO O "APROVADO MAIS PRÓXIMO".
 *
 * O corte de catálogo do guardrail (`corrigirValores`) troca um valor fora da ficha pelo aprovado mais próximo, PULANDO os que já estão
 * na mensagem (para não sair "R$ 350 no Pix (ou R$ 350)"). Na unidade que vende sinal, o valor que o modelo erra é o total com sinal
 * (ele lembra do R$ 250 de antes e a ficha agora diz R$ 200) e o R$ 200 já aparece na própria frase como "o resto no dia":
 *
 *   modelo:  "R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia)"     ficha: 350 / 200 (sinal 50 + 150)
 *   antes:   "R$ 350 no dia, ou R$ 150 garantindo com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia)"     o 200 estava "ocupado" → o 150 foi o mais próximo
 *   agora:   "R$ 350 no dia, ou R$ 200 garantindo com sinal de R$ 50 (R$ 50 agora + R$ 150 no dia)"     o total é o antecipado; o resto é o resto
 *
 * Quem trocou o total pelo antecipado fecha a conta da frase: o "resto no dia" que não bate com a ficha (R$ 200 em vez de R$ 150) também
 * é o número velho. SÓ nas mensagens em que o total foi trocado — fora disso nada é tocado, e "R$ 50 agora + R$ 200 no dia" certo fica como está.
 */

/** Entre o valor e a palavra "garantindo": nada que diga que o valor é o do DIA ("R$ 300 no dia ou com sinal de R$ 50…" — o R$ 300 é o preço no dia). */
const NAO_E_DO_DIA = String.raw`(?!R\$|no\s+dia|na\s+cl[ií]nica|no\s+local|presencial)`;
/** O R$ que vem antes de "garantindo / reservar / com sinal": é o total com sinal. */
const MARCA_DO_TOTAL = new RegExp(String.raw`^(?:${NAO_E_DO_DIA}[^\n.;)]){0,45}?\b(?:garant\w*|reserv\w*|com\s+(?:o\s+|um\s+)?sinal)\b`, 'i');
/** "sinal de R$ 80 para garantir…": o R$ é o próprio sinal (errado), não o total — o texto logo ANTES do valor diz "sinal de". */
const ANTES_E_O_SINAL = /\bsinal\s*(?:de\s+|no\s+valor\s+de\s+|:\s*)?$/i;

/** O valor está no lugar do total com sinal? `antes` / `depois` = o texto colado ao valor, de um lado e do outro. */
export function ehTotalComSinal(antes: string, depois: string): boolean {
  if (ANTES_E_O_SINAL.test(antes)) return false;
  return MARCA_DO_TOTAL.test(depois);
}

const VALOR = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;
export const fmtValor = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));

/** "+ R$ X", "(e R$ X", "e mais R$ X", "faltam R$ X", "os outros R$ X", "o restante, R$ X", "o resto de R$ X" — logo antes do valor. */
const ANTES_DO_RESTO = /(?:\+|\(\s*e|\b(?:mais|falt\w*|restante|resto|outros?|demais)\b)[\s,:(]*(?:de\s+|os\s+|o\s+)*$/i;
/** "… no dia", "… na clínica", "… depois" — logo depois do valor. */
const DEPOIS_DO_RESTO = /^[\s,)]*(?:(?:é|são)\s+)?(?:pago\s+)?(?:no\s+dia|na\s+cl[ií]nica|na\s+consulta|depois|presencial)/i;

/**
 * O "resto no dia" que não é o da ficha vira o da ficha. Só valor que está CLARAMENTE no lugar do resto; parcela ("2x de R$ 75") fica,
 * e valor maior que o antecipado (o preço no dia, "+ R$ 350 no dia") também: o resto de um sinal nunca passa do antecipado.
 */
export function corrigirRestoDoSinal(texto: string, restoNoDia: number, antecipado: number): { texto: string; trocas: string[] } {
  const trocas: string[] = [];
  if (!texto || !Number.isFinite(restoNoDia) || restoNoDia <= 0 || !Number.isFinite(antecipado)) return { texto, trocas };
  const saida = texto.replace(VALOR, (todo, num: string, posicao: number) => {
    const v = Number(num.replace(/\./g, ''));
    if (!Number.isFinite(v) || v === restoNoDia || v > antecipado) return todo;
    const antes = texto.slice(Math.max(0, posicao - 30), posicao);
    if (!ANTES_DO_RESTO.test(antes) || /\d\s*x\s*(?:de\s*)?$/i.test(antes)) return todo;
    if (!DEPOIS_DO_RESTO.test(texto.slice(posicao + todo.length))) return todo;
    trocas.push(`${v}→${restoNoDia}`);
    return `R$ ${fmtValor(restoNoDia)}`;
  });
  return { texto: saida, trocas };
}
