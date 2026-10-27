/**
 * "Sobrou venda?" para o turno de alerta (sinal de alerta, #143).
 *
 * Quando o corte do pronto-socorro deixa a resposta de pé num turno de aviso urgente, o que sobrou não pode vender:
 * valor, horário oferecido, ou o convite para marcar. Se sobrou, a resposta inteira vira a frase do passe. Errar para o
 * lado de trocar é seguro (o paciente em alerta recebe o aviso); errar para o outro lado é vender a quem está mal — mas
 * a pergunta clínica ("começou às 7h?", "há 3h?", "desde 20/10?", "consegue andar?") tem de atravessar, senão o
 * aviso vira sempre a mesma frase.
 */
import { ANTES_DE_DURACAO, HORA, OFERTA_DE_HORARIO, quebrarEmFrases } from './horario-oferecido.js';

/** Fronteira de palavra que funciona antes de letra acentuada (o \b do JS não funciona antes de "à"). */
const INI = String.raw`(?<![\p{L}\p{N}])`;
const FIM = String.raw`(?![\p{L}\p{N}])`;

/** "R$ 150", "150 reais", "150,00", "cento e cinquenta", "duzentos". */
const VALOR = new RegExp(
  [
    String.raw`R\$`,
    String.raw`${INI}\d+(?:[.,]\d{2})?\s*reais${FIM}`,
    String.raw`${INI}\d{2,4},\d{2}${FIM}`,
    String.raw`${INI}(?:cento|duzent[oa]s?|trezent[oa]s?|quatrocent[oa]s?|quinhent[oa]s?)${FIM}`,
  ].join('|'),
  'iu',
);

/**
 * Verbo/termo de venda e de agendamento. Formas escolhidas uma a uma: "marca roxa" e "marcha" não são venda, "segurar a
 * urina" também não; "marcá-la", "agendá-lo" e "reservá-la" são.
 */
const VENDA = new RegExp(
  `${INI}(?:` +
    [
      String.raw`(?:marc|agend|reserv|encaix)(?:ar|á-\w+|ar[eéi]\w*|amos|ad[oa]s?|ue|e|o)`,
      String.raw`garant(?:ir|i-\w+|o|imos|id[oa]s?)`,
      String.raw`vagas?`,
      String.raw`disponibilidade`,
      String.raw`dispon[ií]ve(?:l|is)`,
      String.raw`pix`,
      String.raw`quer\s+(?:ver|garantir|marcar|agendar)`,
      String.raw`posso\s+(?:ver|garantir|te\s+(?:mostrar|passar|mandar|enviar|encaixar))`,
    ].join('|') +
    `)${FIM}`,
  'iu',
);

/** Dia/data/"horário" na frase: com um convite ("tenho", "fica melhor", "que tal") vira oferta de horário. */
const DIA_OU_DATA = new RegExp(
  `${INI}(?:amanh[ãa]|hoje|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|hor[áa]rios?)${FIM}|${INI}\\d{1,2}/\\d{1,2}${FIM}`,
  'iu',
);
/** O paciente contando quando começou: "desde quarta às 7h" é triagem, não agenda. */
const RELATO_DE_INICIO = /\b(?:desde|come[cç]ou|inici\w+|piorou|acord\w+|sentiu|apareceu)\b/i;

const AS_N = new RegExp(`${INI}[àa]s\\s+(\\d{1,2})(?::(\\d{2})|h(\\d{2})?|\\s*horas?)?${FIM}`, 'giu');

/** Horas de relógio na frase (0-23h, 0-59min); "há 3h", "48h", "últimas 24h" são duração e não entram. */
function horasDeRelogio(frase: string): number {
  let n = 0;
  for (const m of frase.matchAll(HORA)) {
    const antes = frase.slice(0, m.index ?? 0);
    const hora = Number(m[1]);
    const min = Number(m[2] ?? m[3] ?? 0);
    if (hora > 23 || min > 59 || ANTES_DE_DURACAO.test(antes)) continue;
    n++;
  }
  for (const m of frase.matchAll(AS_N)) {
    const hora = Number(m[1]);
    const min = Number(m[2] ?? m[3] ?? 0);
    if (hora <= 23 && min <= 59) n++;
  }
  return n;
}

export function sobrouVenda(texto: string): boolean {
  if (VALOR.test(texto) || VENDA.test(texto)) return true;
  for (const { frase } of quebrarEmFrases(texto)) {
    const temDia = DIA_OU_DATA.test(frase);
    // "Tenho quarta às 9h", "pode ser amanhã?", "que tal esse horário?"
    if (OFERTA_DE_HORARIO.test(frase) && (temDia || horasDeRelogio(frase) > 0)) return true;
    // "quarta às 9h", "dia 12/11 às 9" sem convite escrito, a menos que seja o paciente contando o começo da dor
    if (temDia && horasDeRelogio(frase) > 0 && !RELATO_DE_INICIO.test(frase)) return true;
  }
  return false;
}
