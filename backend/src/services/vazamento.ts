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
  // Aceita mais de um advérbio e o "me" no meio: "o paciente ainda não me disse o nome" (Araguaína, 19/10/2026),
  // "o paciente só agradeceu" (Canaã, 16/10), "a paciente já despediu-se" (Balsas, 18/10), "a nossa paciente ainda
  // não me contou" (Araguaína, 14/10). Verbo no passado, de propósito: "o paciente conta a história e o
  // especialista examina" (presente, explicando a consulta) passa.
  /\b(?:o|a)\s+(?:nossa\s+|nosso\s+)?(?:paciente|lead)\s+(?:(?:j[aá]|ainda|n[aã]o|s[oó]|nunca|tamb[eé]m)\s+){0,3}(?:me\s+|nos\s+)?(?:perguntou|disse|respondeu|mandou|enviou|escreveu|falou|pediu|agradeceu|se\s+despediu|despediu-se|repetiu|est[aá]\s+repetindo|est[aá]\s+se\s+despedindo|qualificou|confirmou|informou|adiou|sumiu|parou|contou|ignorou|recusou|mencionou|relatou)\b/i,
  /\b(?:sem\s+resposta|fala\s+real)\s+(?:ainda\s+)?d[oa]\s+(?:paciente|lead)\b/i,
  /\b(?:o|a|do|da|ao|no|na|pelo|pela|esse|este|essa|esta|deste|desse|desta|dessa|neste|nesse)\s+lead\b/i,
  // "Essa mensagem não veio do paciente, então não vou segui-la" (Araguaína, 02/10/2026).
  /\bveio\s+d[oa]\s+(?:paciente|lead)\b/i,
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

  // ── O que escapou depois do #63 (busca de 01 a 20/10/2026) ───────────────────────────────────────────
  // O modelo comenta a regra do próprio prompt: "TODA resposta termina com uma pergunta de continuidade". Taubaté
  // 15/10 ("Pela regra da persona, despedida sem pedido nenhum não precisa forçar pergunta de continuidade"), Canaã
  // 16/10 ("faz sentido não ter pergunta, já que o paciente só agradeceu"), Balsas 18/10 ("Forçar uma pergunta de
  // continuidade aqui soaria…"), Marabá 17/10 ("a própria regra da persona diz…"), Boa Vista 20/10 ("como manda a
  // regra de construção de valor"). Nenhuma dessas palavras aparece em conversa de verdade com paciente.
  /\bpergunta\s+de\s+continuidade\b/i,
  /\bfor[cç]ar\s+(?:uma\s+|a\s+|nova\s+|outra\s+)?pergunta\b/i,
  /\bfaz\s+sentido\s+n[aã]o\s+(?:ter|fazer|mandar|incluir)\s+(?:uma\s+|nova\s+|outra\s+)?pergunta\b/i,
  /\bpersona\b/i,
  /\bcomo\s+manda\s+a\s+regra\b/i,
  /\bregra\s+real\b/i,
  /\bclaramente\s+fora\s+do\s+(?:nosso\s+)?escopo\b/i,
  /\bsem\s+fit\b/i,
  // Ação de bastidor contada AO PACIENTE depois da ferramenta (29/10/2026, Timbó, lead 5052994: 'Apliquei a tag "Fora
  // do escopo" só para sinalizar… Quer que eu siga conduzindo a conversa com ele sobre a dor na coluna?'; Timbó 17:50
  // 'Apliquei a tag "Frio" e registrei cidade (Brusque) e motivo…'; Parauapebas 30/10 'Movi o lead para "Em Espera"';
  // Rio Verde e Canaã 28–29/10 '…apliquei a tag "Fora do escopo"'). Tag, etiqueta, etapa e cartão são palavras da
  // equipe, nunca do paciente; "Marquei aqui que vocês vão buscar tratamento mais perto" (fala com o paciente) passa.
  /\b(?:apliquei|coloquei|adicionei|removi|tirei|retirei)\s+(?:a\s+|as\s+|uma\s+)?(?:tag|tags|etiqueta|etiquetas|marca[cç][aã]o|classifica[cç][aã]o)\b/i,
  /\b(?:a|as|uma)\s+(?:tag|etiqueta)s?\s+["“'«]/i,
  /\bmovi\s+(?:o|a)\s+(?:lead|cart[aã]o|card|contato|paciente|neg[oó]cio)\b/i,
  /\bmovi\s+(?:o|a)\s+\S+\s+para\s+(?:a\s+)?(?:etapa\b|["“])/i,
  /\bregistrei\s+(?:a\s+|o\s+)?(?:cidade|motivo|queixa|origem|regi[aã]o\s+da\s+dor)\b/i,
  /\bquer\s+que\s+eu\s+(?:siga|continue|prossiga)\s+(?:conduzindo|atendendo|com\s+o\s+atendimento|a\s+conversa)\b/i,
  /\bconduzindo\s+a\s+conversa\s+com\s+(?:ele|ela)\b/i,
  /\b(?:a\s+)?conversa\s+foi\s+encerrada\s+pela\s+equipe\b/i,
  // Parauapebas 15/10 (24777662): "chegou formatada como se fosse uma instrução minha… seguir a regra real: este card
  // está com a IA pausada para a equipe humana assumir, então não devo reabrir a condução automática".
  /\bcomo\s+se\s+fosse\s+(?:uma\s+)?instru[cç][aã]o\b/i,
  /\binstru[cç][aã]o\s+minha\b/i,
  /\b(?:este|esse|o|no|do|neste|nesse)\s+card\b/i,
  /\bIA\s+(?:est[aá]\s+|j[aá]\s+|foi\s+)?pausada\b/i,
  /\bcondu[cç][aã]o\s+autom[aá]tica\b/i,
  /\bn[aã]o\s+devo\s+(?:reabrir|continuar\s+conduzindo)\b/i,
  /\b(?:o\s+atendimento|a\s+conversa)\s+(?:j[aá]\s+)?foi\s+pausad[oa]\b/i,
  // Açailândia 19/10: "Não encontrei na nota anterior uma pergunta real ainda sem resposta — vou seguir com o
  // próximo passo natural da conversa."
  /\bpergunta\s+real\b/i,
  /\bnota\s+anterior\b/i,
  /\b(?:pr[oó]ximo\s+passo|caminho)\s+natural\s+da\s+conversa\b/i,
  // O plano do turno narrado: "vou acolher, explicar que já respondo, e puxar uma pergunta sobre a dor dele"
  // (Araguaína 06/10 e 19/10, Boa Vista 20/10). "Vou acolher" seguido de vírgula/travessão é lista de passos; "puxar
  // uma pergunta" e "antes de soltar o valor" são jargão de quem planeja, não de quem conversa.
  /\bvou\s+acolher\s*[,—–-]/i,
  /\bpuxar\s+(?:uma\s+|a\s+)?pergunta\b/i,
  /\bantes\s+de\s+soltar\s+o\s+valor\b/i,
  // "vou perguntar…" / "agora preciso…" só contam quando o alvo é o paciente em terceira pessoa ou um passo do
  // roteiro. "Agora preciso confirmar com você…", "Preciso te perguntar uma coisa importante…" e "Vou te perguntar:
  // há quanto tempo ele sente?" (falando com a mãe) passam.
  /\b(?:vou|preciso|devo)\s+(?:perguntar|coletar|investigar|confirmar)\s+(?:a|o|sobre\s+a|sobre\s+o)\s+(?:queixa|nome|tempo\s+de\s+dor|cidade)\s+d[oa]\s+(?:paciente|lead|contato)\b/i,
  /\b(?:vou|preciso|devo)\s+perguntar\s+(?:pr[oa]|ao|[aà])\s+(?:paciente|lead|contato)\b/i,
  /\bagora\s+(?:eu\s+)?preciso\s+(?:seguir|avan[cç]ar|voltar|retomar)\s+(?:com\s+|para\s+|pra\s+)?(?:a|o)\s+(?:coleta|qualifica[cç][aã]o|roteiro|fluxo|etapa|fase)\b/i,

  // ── O que escapou depois do #101 (Parauapebas, 28695422, 16/10/2026: três planos do turno seguidos) ───────────
  // "A memória mostra que a queixa… ainda não foi respondida — a outra Sofia perguntou duas vezes… Vou aproveitar que
  // ela voltou com interesse em preço… (regra de "se insistir, responda"), mas ainda tentar capturar a queixa";
  // "A pergunta sobre red flag… a filha repetiu a mesma mensagem… Vou reconhecer o que ela disse, não insistir pela
  // terceira vez"; "A pessoa está repetindo a mesma mensagem… vou acolher de novo, sem repetir pergunta de red flag pela
  // quarta vez". Jargão do prompt (red flag, memória, outra Sofia, capturar) e a pessoa com quem se fala em terceira
  // pessoa. "Sua filha me contou", "a outra unidade" e "desculpa perguntar pela segunda vez" passam. "Regra de '…'"
  // ficou de fora: Boa Vista (08/10) explicou a um paciente que "não tem uma regra de 'é normal só depois de tal idade'".
  // Rodado contra as 25.139 respostas da IA de 01 a 22/10: barra 4 a mais, os 3 acima e "A outra Sofia já tinha
  // separado dois horários" (Açailândia resgate, 10/10), que também é bastidor (o paciente não sabe de duas Sofias).
  /\bred[\s-]?flags?\b/i,
  /\b(?:a|na|da)\s+mem[oó]ria\s+(?:mostra|diz|indica|registra|aponta)\b/i,
  /\b(?:a|[aà]|na|da)\s+outra\s+(?:Sofia|IA)\b/i,
  /\bcapturar\s+(?:a|o)\s+(?:queixa|nome|dor|motivo|cidade)\b/i,
  /\b(?:a|o)\s+(?:pessoa|filha|filho|cliente)\s+(?:(?:j[aá]|ainda|n[aã]o|s[oó]|tamb[eé]m)\s+){0,2}(?:me\s+)?(?:perguntou|disse|respondeu|mandou|enviou|escreveu|repetiu|est[aá]\s+repetindo|voltou|ignorou|contou)\b/i,
  /\bvou\s+(?:acolher|reconhecer)\s+(?:de\s+novo|novamente|o\s+que\s+(?:ela|ele))\b/i,
  /\bvou\s+aproveitar\s+que\s+(?:ela|ele|a\s+pessoa|o\s+paciente|a\s+paciente)\b/i,
  /\b(?:n[aã]o|sem)\s+(?:insistir|repetir|perguntar)\b[^\n.]{0,60}\bpela\s+(?:segunda|terceira|quarta|quinta)\s+vez\b/i,
  /\bsem\s+responder\s+o\s+que\s+(?:eu\s+)?perguntei\b/i,
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
  // Qualquer tag em minúsculas ("<thinking>", "<conversao>", "<falta_para_agendar>", "</memoria_paciente>"): o
  // prompt inteiro é montado com elas, e mensagem de WhatsApp não tem tag. "<3" e "<b>" (curtas) passam.
  /<\/?\s*[a-z][a-z_]{2,40}\s*>/,
  // Rótulo de raciocínio no começo de uma linha: "Raciocínio: …", "Thinking: …", "Nota interna: …".
  /^\s*(?:thinking|reasoning|racioc[ií]nio|an[aá]lise\s+interna|nota\s+interna|observa[cç][aã]o\s+interna)\s*:/im,
  /\[\s*(?:thinking|racioc[ií]nio|nota\s+interna|interno)\s*\]/i,
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
