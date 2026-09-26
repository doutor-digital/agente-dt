/**
 * Sexo do paciente deduzido do nome — em código, sem passar pelo modelo.
 *
 * Por que isto existe: a Serra manda no prompt "OBRIGATÓRIO na 1ª resposta: deduza pelo
 * nome (Maria → Feminino)" e entrega 21% de preenchimento. A Canaã manda um morno
 * "quando ficar claro na conversa" e entrega 68%. Instrução mais forte não resolveu, e
 * cada palavra dela viaja em toda chamada. Deduzir sexo de nome é trabalho de função,
 * não de LLM: custa zero token, dá o mesmo resultado toda vez, e dá pra conferir.
 *
 * A REGRA QUE MANDA AQUI: na dúvida, devolve `null`. Campo vazio a recepção percebe e
 * corrige; campo errado ninguém desconfia — e ele vai junto no template, no relatório e
 * na conversa. Por isso a regra ingênua "termina em -a é mulher, senão homem" está fora:
 * medida contra 794 nomes reais, ela acerta 72,5%. Uma em cada quatro pessoas receberia
 * o tratamento errado.
 *
 * O que ficou, e o número de cada um (medido em 26/09/2026, teste cego):
 *   1. lista de nomes do próprio CRM ......... 97,0% de precisão
 *   2. termina em -a → Feminino .............. 94,9%
 *   3. termina em -o → Masculino ............. 94,5%
 *   4. qualquer outra coisa .................. null
 *
 * O TETO, que nenhuma função vence: 74% dos leads têm nome utilizável. Os outros 26% são
 * cartões "Lead 2 25/09/2026" — gente que clicou no anúncio e nunca se apresentou. Pra
 * passar disso é preciso capturar o NOME melhor, não adivinhar o sexo melhor.
 */
import { NOMES } from './nomes-sexo-dados.js';

export type Sexo = 'Feminino' | 'Masculino';

/** Como a dedução chegou — vai pro log, pra dar pra auditar um campo estranho depois. */
export type ComoDeduziu = 'lista' | 'terminacao';

export interface Deducao {
  sexo: Sexo;
  como: ComoDeduziu;
  /** O primeiro nome que decidiu. Útil quando alguém pergunta "por que gravou isso?". */
  nome: string;
}

/**
 * Conectores e títulos que não são o nome da pessoa, e "lead" — que é como o Kommo
 * batiza o cartão quando ninguém se apresentou ("Lead 2 25/09/2026").
 */
const NAO_E_NOME = new Set([
  'lead', 'leads', 'de', 'da', 'do', 'dos', 'das', 'e',
  'sr', 'sra', 'srta', 'dr', 'dra', 'sto', 'sta', 'san',
]);

/** Primeiro pedaço que parece nome de gente. `null` quando não há nenhum. */
export function primeiroNome(bruto: string | null | undefined): string | null {
  const limpo = String(bruto ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpo) return null;
  for (const pedaco of limpo.split(' ')) {
    if (pedaco.length < 2) continue;
    if (NAO_E_NOME.has(pedaco)) continue;
    return pedaco;
  }
  return null;
}

/**
 * Deduz o sexo, ou devolve `null` quando não dá pra afirmar.
 *
 * A lista vem primeiro de propósito: ela conhece os nomes que quebram a terminação —
 * `nicola` e `juca` terminam em -a e são homens, `carmo` termina em -o e é mulher. A
 * terminação só entra em quem a lista não conhece.
 */
export function sexoPeloNome(bruto: string | null | undefined): Deducao | null {
  const nome = primeiroNome(bruto);
  if (!nome) return null;

  const daLista = NOMES.get(nome);
  if (daLista) return { sexo: daLista, como: 'lista', nome };

  // Nome curto demais vira chute: "ba", "zé", "ana" tem 3 e já está na lista.
  if (nome.length < 4) return null;

  if (nome.endsWith('a')) return { sexo: 'Feminino', como: 'terminacao', nome };
  if (nome.endsWith('o')) return { sexo: 'Masculino', como: 'terminacao', nome };
  return null;
}
