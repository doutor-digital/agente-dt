/**
 * A Sofia é a recepção de uma clínica, não uma amiga da paciente.
 *
 * Pedido do João em 26/09/2026, olhando uma mensagem real de Rio Verde:
 * *"Por nada, Ricardo! Um até logo bem carinhoso pra você 😊 Nos vemos segunda-feira!"* —
 * "tá muito íntimo". Medido antes de mexer, 30 dias, mensagens da IA:
 *
 *   com carinho 421 · um beijo 49 · carinhoso/carinhosa 37 · meu bem 18 ·
 *   querida/querido 16 (29 com "minha/meu" na frente) · fofa 5
 *
 * Rio Verde 53, Parauapebas 51, Araguaína 40, Serra 32.
 *
 * POR QUE UMA TRAVA E NÃO SÓ UMA REGRA: Boa Vista JÁ tem a regra escrita na ficha, com todas
 * as letras ("é PROIBIDO escrever 'um beijo'"), e mesmo assim acumulou 16 casos no mês. É a
 * terceira vez que esta lição aparece (ver `sem-coracao.ts` e `sem-diminutivo.ts`): instrução
 * reduz, porta de saída resolve.
 *
 * ── SUBSTITUIR, NÃO APAGAR ─────────────────────────────────────────────────────────────
 * A primeira versão disto apagava o trecho, e foi reprovada na revisão por mutilar a frase:
 * *"Um beijo grande pra você e toda sua família."* virava *". e toda sua família."*, e
 * *"Um beijo!"* sozinho virava *"!"* — que o `temPalavra` do webhook descarta calado, ou
 * seja, a paciente simplesmente não receberia resposta.
 *
 * O motivo é gramatical: nas 49 ocorrências reais, "beijo" é SEMPRE o núcleo de uma
 * despedida coordenada — "Um beijo e melhoras!", "Um beijo pro seu esposo", "Um beijo e até
 * breve". Tirar o núcleo derruba a coordenação. Trocar por "um abraço" mantém a frase
 * inteira e no mesmo tom — e não inventa voz nenhuma: a Sofia já escreve "um abraço"
 * 1.567 vezes por mês. É o registro que a rede usa; só estamos empurrando o desvio de volta
 * pra ele.
 *
 * ── O QUE NÃO ENTRA, e é o cuidado que importa ─────────────────────────────────────────
 * "linda" (44) e "amor" (5) ficaram de fora de propósito: são resposta a elogio do paciente
 * — *"Que mensagem linda"*, *"que amor da sua parte"*. Isso é calor humano legítimo.
 *
 * "carinhoso/carinhosa" só sai quando qualifica a DESPEDIDA ("um abraço bem carinhoso").
 * Nos casos reais ele também aparece em *"que lembrança carinhosa"*, *"suas palavras tão
 * carinhosas"*, *"a equipe é carinhosa"* — falando do paciente ou da clínica, não íntimo.
 * Uma regra solta em `carinhos[ao]` produzia *"A nossa equipe é."*
 */

/** Vocativos íntimos, com o possessivo que aparece de verdade ("minha querida" é o caso comum). */
const VOCATIVO = '(?:meu\\s+bem|(?:minha\\s+|meu\\s+)?querid[ao]|fofa)';

/** Núcleos de despedida que o adjetivo íntimo costuma qualificar. */
const DESPEDIDA = '(?:abraço|até\\s+logo|tchau)';

/** Copia a caixa do original: "Beijos" → "Um abraço", "um beijo" → "um abraço". */
function comAMesmaCaixa(original: string, novo: string): string {
  if (!original || !novo) return novo;
  const primeira = original[0]!;
  if (primeira !== primeira.toLowerCase()) return novo[0]!.toUpperCase() + novo.slice(1);
  return novo;
}

export function semIntimidade(texto: string): string {
  if (!texto) return texto;
  let out = texto;

  // 1. "Um beijo", "Beijos", "Um beijo grande" → "um abraço". O \b final protege "beijou".
  //    Os qualificadores ("grande", "bem carinhoso") saem junto: "Um abraço grande" soa
  //    igualmente íntimo.
  out = out.replace(
    /\b(?:um\s+|uns\s+)?beijo(?:s)?(?:\s+(?:bem\s+|super\s+|muito\s+)?(?:grande|enorme|carinhos[ao]|apertado))?\b/gi,
    (m) => comAMesmaCaixa(m, 'um abraço'),
  );

  // 2. "com carinho" e variações — adverbial, sai sem deixar buraco:
  //    "deixo anotado com carinho aqui" → "deixo anotado aqui".
  //    [ \t]+ e não \s+: com \s+ um "me chama.\nCom carinho, Sofia" virava "me chama., Sofia".
  out = out.replace(/[ \t]+com\s+(?:muito\s+|todo\s+o?\s*)?carinho\b/gi, '');
  //    E se vier abrindo linha, é assinatura: viva como despedida.
  out = out.replace(/(^|\n)[ \t]*com\s+(?:muito\s+|todo\s+o?\s*)?carinho\b/gi, (_m, ini: string) => `${ini}Um abraço`);

  // 3. Adjetivo íntimo SÓ quando qualifica a despedida: "um abraço bem carinhoso" → "um abraço".
  out = out.replace(
    new RegExp(`\\b(${DESPEDIDA})\\s+(?:bem\\s+|super\\s+|muito\\s+|tão\\s+)?carinhos[ao]\\b`, 'gi'),
    '$1',
  );

  // 4. Vocativos. A pontuação anda junto — tirar o vocativo e deixar a vírgula para trás
  //    produziria "Oi, Como você está?".
  //    "Oi, querida! Como..." → "Oi! Como..."
  out = out.replace(new RegExp(`,\\s*${VOCATIVO}\\s*([!?.])`, 'gi'), '$1');
  //    "Claro, meu bem, já te explico" → "Claro, já te explico"
  out = out.replace(new RegExp(`,\\s*${VOCATIVO}\\s*,`, 'gi'), ',');
  //    "Querida, me conta..." → "Me conta..." — a próxima palavra recupera a maiúscula.
  out = out.replace(
    new RegExp(`(^|[.!?][ \\t]+|\\n)${VOCATIVO}\\b[,!.]?[ \\t]*(\\p{Ll})`, 'giu'),
    (_m, ini: string, letra: string) => ini + letra.toUpperCase(),
  );

  out = semCicatriz(out);

  // 5. Rede de segurança. Uma trava de tom não pode, em nenhuma hipótese, transformar a
  //    resposta em pontuação solta: o webhook descarta mensagem sem palavra (temPalavra) e a
  //    paciente fica sem resposta. Se sobrou algo sem letra, é bug meu — devolvo o original,
  //    que é íntimo mas chega.
  if (!/\p{L}/u.test(out) && /\p{L}/u.test(texto)) return texto;
  return out;
}

/** Limpa a cicatriz: espaço duplo, espaço antes de pontuação, pontuação repetida. */
function semCicatriz(texto: string): string {
  return texto
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/([,;:])[ \t]*([.!?])/g, '$2')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function temIntimidade(texto: string): boolean {
  return texto !== semIntimidade(texto);
}
