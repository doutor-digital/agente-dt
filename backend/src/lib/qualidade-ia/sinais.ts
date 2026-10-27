/**
 * Sinais OBJETIVOS de erro da Sofia — o que dá para contar sem IA.
 *
 * Fonte única dos padrões: o SQL (`consulta.ts`) os recebe como parâmetro (`content ~* padrão`) e o teste os
 * compila como RegExp para provar o que pega e o que deixa passar. Por isso só usam a parte comum às duas
 * sintaxes (alternação, `.`, parênteses simples) — nada de `\m`, `(?i)` ou lookahead.
 *
 * Lista de partida, não definitiva: cada frase abaixo apareceu (ou foi pedida pelo João) como defeito real.
 * Ampliar é só acrescentar aqui; o teste obriga a escrever um exemplo que pega e um que não pega.
 */

/** Raciocínio interno que vazou para o paciente ("Vou acolher…"). */
export const PADROES_VAZAMENTO = [
  'vou acolher',
  'o paciente ainda não',
  'antes de soltar o valor',
  'preciso acolher',
  'vou conduzir (o|a) (paciente|conversa)',
  'o paciente (acabou de|demonstrou|mencionou|está com)',
] as const;

/** A Sofia admite que não conseguiu fazer a parte dela. */
export const PADROES_FALHA = ['não consegui abrir', 'instabilidade', 'não entendi'] as const;

/** Uma só alternação, no formato que o Postgres (`~*`) e o JavaScript (`i`) entendem igual. */
export const REGEX_VAZAMENTO = PADROES_VAZAMENTO.join('|');
export const REGEX_FALHA = PADROES_FALHA.join('|');

/** Abaixo disto repetir é normal ("Ok!", "Combinado."): só conta repetição de texto com corpo. */
export const MIN_CARACTERES_REPETIDA = 20;

export interface Sinais {
  /** Mensagem da Sofia igual à anterior dela na mesma conversa. */
  repetidas: number;
  /** Raciocínio interno que vazou para o paciente. */
  vazamento: number;
  /** "não consegui abrir", "instabilidade", "não entendi". */
  falha: number;
}

export const SINAIS_ZERADOS: Sinais = { repetidas: 0, vazamento: 0, falha: 0 };

export function totalDeSinais(s: Sinais): number {
  return s.repetidas + s.vazamento + s.falha;
}

/** Espelho em JS do que o SQL faz, para o teste (e para quem quiser conferir uma mensagem na mão). */
export function classificarMensagem(texto: string): { vazamento: boolean; falha: boolean } {
  return {
    vazamento: new RegExp(REGEX_VAZAMENTO, 'i').test(texto),
    falha: new RegExp(REGEX_FALHA, 'i').test(texto),
  };
}
