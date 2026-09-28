/**
 * QUANDO O PACIENTE PEDE PARA A GENTE PARAR, A RÉGUA TEM DE OUVIR.
 *
 * Origem: Glória, lead 22584955 da Serra, 22–24/09/2026. Ela recebeu o preço e dois horários
 * às 17:42; às 17:48 (SEIS minutos depois) tomou o degrau 1 da régua, e às 18:44 o degrau 2.
 * Às 18:50 escreveu "Estou analisando, decidindo, retorno a ligação". Dois dias depois mandou
 * "Bom dia", a IA emendou "conseguiu pensar sobre a consulta?", e ela encerrou:
 *
 *   "não gosto de insistência, principalmente quando se trata de saúde. Falei que ia analisar,
 *    e hoje já vem uma mensagem. Por tal motivo estarei procurando outro profissional."
 *
 * O que a régua faz hoje quando o paciente responde é ZERAR o contador — ou seja, quem adia
 * fica armado para tomar o degrau de 5 minutos outra vez. Medido em 26/09/2026: 25 pacientes
 * pediram tempo ou pediram para parar em 30 dias, e 17 seguiam com a régua armada, em 9
 * unidades — incluindo uma da Boa Vista que escreveu "vcs enche o saco".
 *
 * ── DOIS NÍVEIS, DE PROPÓSITO ─────────────────────────────────────────────────────────────
 * IRRITAÇÃO cala a régua PARA SEMPRE. É gente a um toque de bloquear o número.
 * ADIAMENTO só ADIA: pula os degraus curtos e deixa o toque longo (na escada de qualificação,
 * o de 20 h, que é justamente o "encerramento educado, SEM pedir resposta"). Matar a régua de
 * quem disse "vou falar com meu marido e te aviso" jogaria fora lead bom — a queixa nunca foi
 * receber contato, foi receber contato em seis minutos.
 *
 * ── O QUE FICOU DE FORA, e é o cuidado que importa ────────────────────────────────────────
 * Li 44 mensagens reais antes de escrever qualquer regex, e três candidatos óbvios caíram:
 *
 *   "para de"   → "Para de tarde" (= para a TARDE), "não para de doer", "não posso parar de
 *                 trabalhar". Nada disso é pedido para parar.
 *   "já falei"  → quase sempre é o paciente REPETINDO informação: "Já falei da dor e meu nome",
 *                 "Como já falei, na lombar". Na única frase que era irritação de verdade o
 *                 sinal estava em "enche o saco", não no "já falei".
 *   "spam"      → "olha em spam tbm" é a paciente AJUDANDO a gente a achar a mensagem.
 *
 * É a quarta vez que um regex meu quase pegou o contrário do que devia. A regra é sempre a
 * mesma: ler as frases reais antes, não depois.
 */

/** Pedido explícito de parar. Vocabulário estreito de propósito: o custo do falso positivo
 *  aqui é calar a régua de um lead bom, então só entra o que não tem outra leitura. */
const IRRITACAO: RegExp[] = [
  /\binsist[êe]ncia\b|\binsistindo\b|\binsistente\b/i,
  /\bench(?:e|er|endo)\s+o\s+saco\b/i,
  /\bme\s+deix[ae]\s+em\s+paz\b/i,
  // Exige o "me" e um verbo de contato: é o que separa de "não para de doer".
  /\b(?:n[ãa]o|pare?m?\s+de|parem?\s+de)\s+me\s+(?:manda|mande|mandar|encher|perturbar|procurar|liga|ligar)\b/i,
  /\bvou\s+(?:te\s+)?(?:bloquear|denunciar)\b/i,
  // "Acho que e golpe" (sem acento) é como aparece de verdade. Mas NUNCA só /golpe/:
  // em clínica de coluna, "levei um golpe nas costas" é uma pancada, não uma acusação.
  //
  // E a suspeita no PASSADO é o contrário de irritação: "Eu achava que isso e golpe" quer
  // dizer que ela deixou de achar — é sinal quente. Apareceu 1 vez em 48 mil mensagens e
  // era o único falso positivo da regra.
  /(?<!\b(?:achava|achei|pensava|pensei|imaginei|imaginava)\b[^.!?]{0,25})\b(?:é|eh|e|parece|virou)\s+golpe\b/i,
  /\b(?:voc[êe]s|vcs)\s+(?:s[ãa]o|est[ãa]o\s+sendo)\s+(?:muito\s+)?chat[oa]s?\b/i,
  /\bme\s+(?:tira|tire|remove|exclu[ai])\s+d(?:a|essa)\s+lista\b|\bdescadastr/i,
];

/** Adiamento: "me chama depois", dito de mil jeitos. */
const ADIAMENTO: RegExp[] = [
  /\bvou\s+analisar\b|\bestou\s+analisando\b|\bvou\s+pensar\b/i,
  /\b(?:eu\s+)?(?:te\s+)?retorno\b|\bvolto\s+a\s+falar\b|\bentro\s+em\s+contato\b/i,
  /\bqualquer\s+coisa\s+eu\s+(?:te\s+)?(?:chamo|aviso|falo|procuro)\b/i,
  /\bvou\s+(?:conversar|falar)\s+com\s+(?:meu|minha|o|a|ele|ela|eles)\b/i,
  /\bquando\s+(?:eu\s+)?(?:decidir|puder|resolver|conseguir)\b/i,
  /\bvou\s+verificar\b/i,
  /\bdepois\s+eu\s+(?:te\s+)?(?:falo|aviso|chamo|vejo)\b/i,
  // "vou ver" é largo demais sozinho ("vou ver o nome aqui" é dar informação AGORA),
  // então só conta acompanhado de uma promessa de voltar ou de consultar alguém.
  /\bvou\s+ver\b(?:(?!\bR\$).){0,40}?\b(?:te\s+(?:falo|aviso|digo)|e\s+(?:te\s+)?(?:falo|aviso|fala)|se\s+consigo|com\s+(?:meu|minha|o|a|ele|ela)|aqui\s+depois|depois)/i,
];

export type MotivoDeParada = 'irritacao' | 'adiamento';

export function pediuParaParar(texto: string): MotivoDeParada | null {
  if (!texto || !texto.trim()) return null;
  if (IRRITACAO.some((re) => re.test(texto))) return 'irritacao';
  if (ADIAMENTO.some((re) => re.test(texto))) return 'adiamento';
  return null;
}

/**
 * Só um cumprimento, sem assunto.
 *
 * Serve à terceira trava: quando a paciente volta dias depois e diz "Bom dia", responder
 * "conseguiu pensar sobre a consulta?" é, na leitura dela, a enésima cobrança — foi
 * literalmente o que fez a Glória desistir. Cumprimento se responde com cumprimento, e
 * quem conduz o assunto é ela.
 */
// Fronteira unicode, não `\b`: em JS o `\b` é ASCII, então depois do "á" de "Olá" ele NÃO
// acha fronteira nenhuma e "Olá!" deixava de ser reconhecido como cumprimento. Mesmo problema
// valeria para "e aí".
const CUMPRIMENTOS =
  /(?<![\p{L}\p{N}])(?:bom\s+dia|boa\s+tarde|boa\s+noite|ol[áa]|oi+|oie+|opa|e\s*a[íi]|tudo\s+bem|tudo\s+bom|como\s+vai|blz|beleza)(?![\p{L}\p{N}])/giu;

export function ehSoCumprimento(texto: string): boolean {
  if (!texto || !texto.trim()) return false;
  const resto = texto
    .replace(CUMPRIMENTOS, ' ')
    // emoji, pontuação e o nome da clínica não são assunto
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return resto.length === 0;
}
