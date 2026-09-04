/**
 * Encerramento de conversa: quando NÃO responder.
 *
 * Caso real (Parauapebas, 04/09/2026, lead 25179568): o paciente fechou com
 * "Ok obrigado", a Sofia respondeu "Eu que agradeço…", ele mandou "🙏" e ela
 * respondeu de novo "Por nada…". Cada agradecimento virava mais uma despedida —
 * repetitivo e artificial. O agrupamento de mensagens (coalescer) não resolve
 * isso: as mensagens vieram com um minuto de intervalo e uma resposta no meio.
 *
 * Regra: um agradecimento/ok/emoji solto recebe UMA despedida. O segundo em
 * sequência (com a nossa despedida entre eles, há pouco tempo) fica sem resposta.
 * Pergunta, pedido ou qualquer frase com conteúdo não é encerramento e segue normal.
 */

export interface MensagemHistorico {
  role: string; // 'user' | 'assistant' | ...
  content: string;
  createdAt: Date;
}

/** Janela em que a despedida da IA ainda "vale": depois disso, um novo "obrigado" é conversa nova. */
export const JANELA_ENCERRAMENTO_MS = 15 * 60_000;

const RE_PALAVRAS =
  /^(ok(ay|ei)?|okk+|blz|beleza|show|top|perfeito|certo|combinado|fechado|entendi|entendido|obrigad[oa]s?|brigad[oa]|valeu|vlw|tks|thanks|thank you|grat[oa]|agrade[çc]o|de nada|por nada|tchau|at[ée] (mais|logo|breve|amanh[ãa])|bom dia|boa tarde|boa noite|boa semana|bom fim de semana|bom final de semana|abra[çc]os?|abs|fica com deus|deus aben[çc]oe|am[ée]m|sim|n[ãa]o|t[áa]|ta bom|t[áa] bom|tudo bem|isso|uhum|aham|👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|🙏|🙏🏻|🙏🏼|🙏🏽|🙏🏾|🙏🏿|❤️|❤|💙|💚|🤗|😊|☺️|☺|🙂|😉|😁|😄|✌️|👏|🫶)$/i;

/** Só emojis / pontuação / espaços (ex.: "🙏🙏", "👍!!"). */
const RE_SO_SIMBOLOS = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍\s.!,;:…]+$/u;

/** Expressões de 2–4 palavras que contam como uma só. */
const FRASES = [
  /\bt[áa] bom\b/g, /\btudo bem\b/g, /\bde nada\b/g, /\bpor nada\b/g, /\bat[ée] (mais|logo|breve|amanh[ãa]|a pr[óo]xima)\b/g,
  /\bbom dia\b/g, /\bboa tarde\b/g, /\bboa noite\b/g, /\bboa semana\b/g, /\bbom (fim|final) de semana\b/g,
  /\bfica com deus\b/g, /\bdeus aben[çc]oe\b/g, /\bthank you\b/g, /\bmuito obrigad[oa]s?\b/g, /\bobrigad[oa] pelo atendimento\b/g,
  /\bobrigad[oa] pela aten[çc][ãa]o\b/g, /\bum abra[çc]o\b/g,
];

/** "Ok obrigado", "valeu 🙏", "tá bom, obrigada!" — agradecimento/ok sem conteúdo novo. */
export function ehEncerramento(texto: string): boolean {
  let t = texto.trim().toLowerCase();
  if (!t || t.length > 60) return false;
  if (t.includes('?')) return false;
  if (RE_SO_SIMBOLOS.test(t)) return true;
  t = t.replace(/[.!,;:…]+/g, ' ');
  for (const f of FRASES) t = t.replace(f, ' ');
  const pedacos = t.split(/\s+/).filter(Boolean);
  if (pedacos.length > 4) return false;
  return pedacos.every((p) => RE_PALAVRAS.test(p) || RE_SO_SIMBOLOS.test(p));
}

/**
 * True quando a mensagem atual é um encerramento E a IA já respondeu a um
 * encerramento deste paciente há pouco: não responder de novo.
 *
 * `historico` = mensagens anteriores da conversa (sem a atual), qualquer ordem.
 */
export function ehEncerramentoRepetido(
  mensagemAtual: string,
  historico: MensagemHistorico[],
  agora: Date = new Date(),
): boolean {
  if (!ehEncerramento(mensagemAtual)) return false;
  const ordenado = [...historico].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const ultima = ordenado.at(-1);
  if (!ultima || ultima.role !== 'assistant') return false;
  if (agora.getTime() - ultima.createdAt.getTime() > JANELA_ENCERRAMENTO_MS) return false;
  // O TURNO do paciente logo antes da nossa última resposta (mensagens seguidas dele,
  // que o coalescer juntou num pedido só) também era só encerramento? Se uma delas
  // tinha conteúdo ("Irei verificar aí aviso vcs" + "Obrigado"), a resposta da IA
  // foi a um pedido, não a uma despedida — e o "Ok obrigado" seguinte ainda merece uma.
  const turnoAnterior: MensagemHistorico[] = [];
  let i = ordenado.length - 1;
  while (i >= 0 && ordenado[i].role !== 'user') i--; // pula as respostas finais da IA
  while (i >= 0 && ordenado[i].role === 'user') turnoAnterior.push(ordenado[i--]);
  if (turnoAnterior.length === 0) return false;
  return turnoAnterior.every((m) => ehEncerramento(m.content));
}
