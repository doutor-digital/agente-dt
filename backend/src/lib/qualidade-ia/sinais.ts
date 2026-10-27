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

/**
 * A Sofia admite que não conseguiu fazer a parte dela. Restrito de propósito (revisão do #144):
 *  - "instabilidade" é termo clínico de coluna ("instabilidade da coluna lombar"); só conta em frase de falha
 *    TÉCNICA da própria Sofia ("tivemos uma instabilidade", "instabilidade no sistema");
 *  - "não entendi" só no começo da resposta, com ou sem pedido de desculpa, e sem assunto clínico na mesma
 *    mensagem ("não entendi qual região da coluna dói" é pergunta legítima, não falha).
 */
export const PADROES_FALHA_TECNICA = [
  'não consegui abrir',
  '(tive|tivemos|houve|estou com|estamos com) (uma )?instabilidade',
  'instabilidade (no|na|em) (sistema|conexão|atendimento|rede|internet|whatsapp)',
] as const;
export const PADROES_NAO_ENTENDI = ['^ *((desculpe|desculpa|perdão|poxa|ops)[,!. ]*)?não entendi'] as const;
/** Se a mensagem de "não entendi" também fala disto, é conversa clínica: não conta. */
export const PADROES_CLINICOS = [
  '(^|[^a-zà-ú])dores?($|[^a-zà-ú])',
  'coluna',
  'lombar',
  'cervical',
  'hérnia',
  'exame',
  'ressonância',
  'sintoma',
  'joelho',
  'ombro',
  'perna',
  'braço',
] as const;

/** Uma só alternação, no formato que o Postgres (`~*`) e o JavaScript (`i`) entendem igual. */
export const REGEX_VAZAMENTO = PADROES_VAZAMENTO.join('|');
export const REGEX_FALHA_TECNICA = PADROES_FALHA_TECNICA.join('|');
export const REGEX_NAO_ENTENDI = PADROES_NAO_ENTENDI.join('|');
export const REGEX_CLINICO = PADROES_CLINICOS.join('|');

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
  const tecnica = new RegExp(REGEX_FALHA_TECNICA, 'i').test(texto);
  const naoEntendi = new RegExp(REGEX_NAO_ENTENDI, 'i').test(texto) && !new RegExp(REGEX_CLINICO, 'i').test(texto);
  return { vazamento: new RegExp(REGEX_VAZAMENTO, 'i').test(texto), falha: tecnica || naoEntendi };
}
