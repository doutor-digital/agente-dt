/**
 * Coração não sai mais nas mensagens da Sofia.
 *
 * Pedido do João em 19/09/2026, e é a terceira vez que o assunto volta. O motivo
 * de nunca ter morrido está na tabela de downgrade de emoji: ela CONVERTIA ❤️,
 * 💙, 💗 e companhia em `♥` — um símbolo de 1993, que fica pior que o original.
 * Então a regra no prompt mandava não usar coração, o modelo às vezes usava, e o
 * nosso próprio código transformava num coração mais feio em vez de remover.
 *
 * Medido antes de mexer: 679 de 3.881 mensagens em 2 dias (17%) saíam com `♥`,
 * em praticamente todas as unidades — "Prazer, Daiane! ♥".
 *
 * Aqui é a última porta antes do paciente. Tirar no fim do caminho resolve
 * independente do que o prompt ensina, do que o modelo inventa e de qual unidade
 * é — e nenhum exemplo esquecido num prompt volta a furar.
 *
 * O cuidado é não deixar cicatriz: "Prazer, Daiane! ♥" tem que virar
 * "Prazer, Daiane!", não "Prazer, Daiane! " com espaço sobrando.
 */

/**
 * Corações em todas as formas que aparecem: o BMP antigo (`♥ ♡ ❤ ❣`), os
 * coloridos (💙 💚 💛 🧡 💜 🤍 🖤 🤎), os decorados (💕 💖 💗 💓 💝 💞 💘 💟) e o
 * `❤️` com o seletor de variação invisível grudado atrás.
 *
 * A flag `u` não é opcional: sem ela o JavaScript compara por metade de par
 * substituto e um 🙏 passa a casar com 💗 — foi assim que eu quase reportei um
 * alarme falso em 18/09.
 */
const CORACOES =
  /[❤♡♥❣\u{1F493}-\u{1F49F}\u{1F5A4}\u{1FA75}-\u{1FA77}\u{1F90D}\u{1F90E}\u{1F9E1}][︎️]?/gu;

export function temCoracao(texto: string): boolean {
  return CORACOES.test(texto);
}

/**
 * Tira os corações e fecha o buraco que eles deixam.
 *
 * A ordem importa: primeiro remove, depois junta espaço duplicado, depois cola a
 * pontuação que ficou órfã, e só então apara as pontas.
 */
export function semCoracao(texto: string): string {
  if (!texto) return texto;
  return texto
    .replace(CORACOES, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}
