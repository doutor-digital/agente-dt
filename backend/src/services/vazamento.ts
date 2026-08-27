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
 * A regra aqui é conservadora de propósito: na dúvida, DEIXA PASSAR. Segurar
 * mensagem boa é pior que deixar escapar uma ruim — o paciente calado é o lead
 * perdido. Por isso cada padrão exige evidência forte, não um "parece estranho".
 */

export type TipoVazamento =
  | 'tool_call_em_texto'
  | 'raciocinio_em_ingles'
  | 'placeholder_nao_preenchido'
  | 'bloco_interno';

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
  }
}
