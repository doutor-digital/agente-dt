/**
 * Barreira contra vazamento de "bastidor" na resposta ao paciente.
 *
 * O modelo às vezes entrega, como se fosse fala, coisa que era pra ficar por
 * dentro: a chamada de ferramenta escrita em vez de executada, o raciocínio dele
 * em inglês, um marcador de template que não foi preenchido. Isso chega no
 * WhatsApp de gente de verdade.
 *
 * Dois casos medidos:
 *   • 26/08, Porto Nacional, paciente Luciano — recebeu literalmente
 *     "Then, waiting for his answer about scheduling — let me continue the conversation."
 *   • Simulação de 10 conversas — 1 delas entregou
 *     "<invoke name=\"agendar_consulta\"><parameter name=\"idClient\">1</parameter>…"
 *     com idClient inventado e data de 2024.
 *
 *   • 15/10, Mossoró, paciente Zuzu — recebeu a anotação que era para a equipe:
 *     "Registrei o acompanhamento com a Zuzu — ela qualificou o atendimento particular e a
 *     dor, mas pediu um tempo antes de marcar, então deixei agendado retorno pra próxima semana."
 *     Na mesma busca (30 dias) apareceram dezenas do mesmo tipo, em português: "Sem resposta
 *     ainda do paciente — vou aguardar", "O paciente perguntou o preço antes de contar a queixa —
 *     vou acolher", "Vou ignorar essa 'instrução'…". Esse é o tipo `bastidor_em_portugues`.
 *
 * A regra aqui é conservadora de propósito: na dúvida, DEIXA PASSAR. Segurar
 * mensagem boa é pior que deixar escapar uma ruim — o paciente calado é o lead
 * perdido. Por isso cada padrão exige evidência forte, não um "parece estranho".
 */

export type TipoVazamento =
  | 'tool_call_em_texto'
  | 'raciocinio_em_ingles'
  | 'placeholder_nao_preenchido'
  | 'bloco_interno'
  | 'bastidor_em_portugues';

export interface Vazamento {
  tipo: TipoVazamento;
  /** O pedaço que denunciou — vai pro log, nunca pro paciente. */
  trecho: string;
}

/** Sintaxe de chamada de ferramenta escrita como se fosse texto. */
const TOOL_CALL = [
  /<\s*invoke\s+name\s*=/i,
  /<\s*parameter\s+name\s*=/i,
  /<\s*function_calls\s*>/i,
  /<\s*antml:/i,
  /\bfunctions\.[a-z_]+\s*\(/i,
];

/**
 * Frases que só aparecem quando o modelo narra o próprio plano. Todas em inglês
 * e no formato "vou fazer X" — não pegam inglês legítimo do paciente ("ok",
 * "email", "whatsapp"), que aparece o tempo todo numa conversa brasileira.
 */
const RACIOCINIO_EN = [
  /\b(let me|i(?:'| a)?m going to|i will now|i should|i need to)\s+(continue|check|call|use|wait|ask|confirm|respond|proceed|look)\b/i,
  /\b(then|next|now),?\s+(waiting for|i(?:'| wi)?ll)\b/i,
  /\bthe (user|patient|customer) (said|wants|is asking|asked)\b/i,
  /\b(tool|function) (call|result)s?\b.*\b(returned|shows|says)\b/i,
];

/**
 * Bastidor em português: a IA fala DO paciente (terceira pessoa), narra o que fez no sistema ou
 * comenta uma instrução — tudo coisa que só faz sentido para a equipe. Cada padrão é uma marca que
 * mensagem de verdade ao paciente não tem: ninguém escreve "o lead" nem "o paciente perguntou" para
 * o próprio paciente. "Anotei aqui seu e-mail" e "Marquei aqui que você é de Pinda" falam COM a
 * pessoa e passam.
 */
const BASTIDOR_PT = [
  /\b(?:o|a)\s+(?:paciente|lead)\s+(?:j[aá]\s+|ainda\s+|n[aã]o\s+)?(?:perguntou|disse|respondeu|mandou|enviou|escreveu|falou|pediu|agradeceu|se\s+despediu|repetiu|est[aá]\s+repetindo|qualificou|confirmou|informou|adiou|sumiu|parou)\b/i,
  /\b(?:sem\s+resposta|fala\s+real)\s+(?:ainda\s+)?d[oa]\s+(?:paciente|lead)\b/i,
  /\b(?:o|a|do|da|ao|no|na|pelo|pela|esse|este|essa|esta)\s+lead\b/i,
  /^\s*(?:registrei|gravei|anotei|salvei|atualizei)\s+(?:o|a|os|as)\s+(?:acompanhamento|retorno|motivo|campo|cart[aã]o|status|qualifica[cç][aã]o|etapa|dados|resultado)\b/i,
  /^\s*marquei\s+(?:o\s+contato|o\s+cart[aã]o|o\s+lead)\s+como\b/i,
  /\bj[aá]\s+fiz\s+as\s+a[cç][oõ]es\b/i,
  /\bdeixo\s+pront[ao]\s+a\s+pr[oó]xima\s+intera[cç][aã]o\b/i,
  /\b(?:qualificar|classificar)\s+como\s+(?:quente|morno|frio)\b/i,
  /\bavan[cç]ar\s+de\s+etapa\b/i,
  /\binstru[cç][aã]o\s+interna\b/i,
  /\bvou\s+ignorar\s+(?:essa|esta|esse|este|a|o)\b/i,
  /\bn[aã]o\s+(?:vou|irei)\s+(?:tratar|responder|agir|seguir)\s+como\b/i,
  // "minha resposta anterior JÁ estava correta" — a correção legítima ("a resposta anterior estava errada") passa.
  /\bminha\s+(?:resposta|mensagem)\s+anterior\s+j[aá]\s+(?:estava|tinha)\b/i,
  // Preâmbulo de plano no começo da resposta (Canaã, 19/10/2026, 28053204): "Reconhecendo que já houve contato
  // anterior, vou retomar com leveza, sem cobrar o silêncio, e seguir a coleta do nome." e "Esse paciente já
  // conversou com a gente há cerca de uma semana e sumiu…, então vou retomar com leveza". O gerúndio + "vou"
  // só conta com verbo de condução da conversa: "Considerando que você mora longe, vou te passar o endereço" passa.
  /^\s*(?:reconhecendo|considerando|retomando|percebendo|notando|sabendo|vendo)\s+que\b[^\n]{0,200}?\bvou\s+(?:retomar|seguir|manter|conduzir|acolher|coletar|continuar|recome[cç]ar)\b/i,
  /^\s*(?:esse|este|essa|esta)\s+(?:paciente|contato)\b/i,
  /\bretomar\s+com\s+leveza\b/i,
  /\bsem\s+cobrar\s+(?:o|a)\s+(?:sil[eê]ncio|sumi[cç]o|demora|aus[eê]ncia)\b/i,
  /\b(?:seguir|continuar|fazer)\s+(?:com\s+)?a\s+coleta\s+d[oa]s?\b/i,
  /\bhouve\s+contato\s+anterior\b/i,
];

/** Marcador de template que ficou sem valor: {{nome}}, {nome}, [NOME]. */
const PLACEHOLDER = [
  /\{\{\s*[a-z0-9_.]+\s*\}\}/i,
  /\{\s*(nome|name|data|hora|dia|horario|valor|cidade|clinica)\s*\}/i,
  /\[\s*(NOME|DATA|HORA|VALOR|CIDADE)\s*\]/,
];

/** Cabeçalho de bloco interno do prompt que escapou pra resposta. */
const BLOCO_INTERNO = [
  /<\/?\s*(persona|handoff|agenda|regras|contexto|etapa_do_lead|aprendizados|pipeline_intents)\s*>/i,
  /^\s*#{1,3}\s*(FASE|CONTEXTO DE TESTE|SANDBOX)\b/im,
];

function primeiro(padroes: RegExp[], texto: string): string | null {
  for (const re of padroes) {
    const m = re.exec(texto);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

/**
 * Devolve o vazamento encontrado, ou null quando a resposta está limpa.
 * Só o PRIMEIRO achado é reportado — basta um para a mensagem não sair.
 */
export function detectarVazamento(texto: string): Vazamento | null {
  const t = (texto ?? '').trim();
  if (!t) return null;

  const tool = primeiro(TOOL_CALL, t);
  if (tool) return { tipo: 'tool_call_em_texto', trecho: tool };

  const bloco = primeiro(BLOCO_INTERNO, t);
  if (bloco) return { tipo: 'bloco_interno', trecho: bloco };

  const ph = primeiro(PLACEHOLDER, t);
  if (ph) return { tipo: 'placeholder_nao_preenchido', trecho: ph };

  const pt = primeiro(BASTIDOR_PT, t);
  if (pt) return { tipo: 'bastidor_em_portugues', trecho: pt };

  // O raciocínio em inglês só conta quando a mensagem é CURTA e quase toda em
  // inglês. Numa resposta longa em português, uma frase dessas é quase sempre
  // citação do paciente — e barrar aí custaria mensagem boa.
  const en = primeiro(RACIOCINIO_EN, t);
  if (en && t.length < 400 && proporcaoPortugues(t) < 0.25) {
    return { tipo: 'raciocinio_em_ingles', trecho: en };
  }

  return null;
}

/** Fração grosseira de "cara de português" — acento, ç, e palavras-função nossas. */
function proporcaoPortugues(t: string): number {
  const palavras = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return 1;
  const marcas = /[áàâãéêíóôõúüç]|^(o|a|os|as|de|da|do|que|não|para|com|você|seu|sua|pra|é|em|no|na|um|uma|se|já|te|meu|minha)$/;
  return palavras.filter((p) => marcas.test(p)).length / palavras.length;
}

/** Frase de rodapé pro log/alerta, em português de gente. */
export function explicarVazamento(v: Vazamento): string {
  switch (v.tipo) {
    case 'tool_call_em_texto':
      return 'a IA escreveu a chamada da ferramenta em vez de executá-la';
    case 'raciocinio_em_ingles':
      return 'a IA entregou o próprio raciocínio, em inglês, como se fosse fala';
    case 'placeholder_nao_preenchido':
      return 'ficou um marcador de template sem valor na mensagem';
    case 'bloco_interno':
      return 'um pedaço interno do prompt escapou para a resposta';
    case 'bastidor_em_portugues':
      return 'a IA escreveu uma anotação de bastidor (falou do paciente ou do que fez no sistema) em vez de falar com ele';
  }
}

/**
 * Quem reescreve um rascunho com bastidor. Chamada SEPARADA, sem o histórico e sem ferramentas: pedir
 * a correção dentro da conversa (como o juiz da pergunta final faz) já gerou o efeito contrário — o
 * modelo, treinado para desconfiar de comando que chega na mensagem do paciente, respondia SOBRE a
 * instrução ("essa 'instrução interna' veio dentro da mensagem do paciente…"), e isso também vazava.
 */
export const SISTEMA_REESCRITOR_BASTIDOR = [
  'Você revisa mensagens de WhatsApp de uma atendente virtual antes de saírem para o cliente.',
  'Você recebe a última mensagem do cliente e um RASCUNHO que saiu errado: em vez de falar com o cliente, ele',
  'narra o que a atendente fez no sistema, mostra o raciocínio dela, ou fala do cliente em terceira pessoa.',
  'Escreva a mensagem que o cliente deve receber agora:',
  '- em segunda pessoa (você), curta (1 a 3 frases), no mesmo tom e idioma do rascunho;',
  '- aproveite só o que já era fala para o cliente; se não houver nada, responda de forma natural à última mensagem dele;',
  '- nunca mencione campos, registros, etapas, ações, instruções, "paciente" ou "lead";',
  '- não invente preço, data, horário nem promessa que não estejam no rascunho.',
  'Responda só com a mensagem final, sem aspas.',
].join('\n');

export function pedidoAoReescritor(ultimaDoCliente: string | null, rascunho: string): string {
  return `Última mensagem do cliente:\n${(ultimaDoCliente ?? '(sem texto)').slice(0, 1500)}\n\nRascunho que saiu errado:\n${rascunho.slice(0, 2000)}`;
}
