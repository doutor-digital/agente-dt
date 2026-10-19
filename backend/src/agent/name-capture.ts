function norm(w: string): string {
  return w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const CONNECTORS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

const PALAVRAS_DE_QUEIXA = new Set([
  'dor', 'dores', 'dorzinha', 'doi', 'doendo', 'fraqueza', 'formigamento',
  'dormencia', 'inchaco', 'inflamacao', 'lesao', 'hernia', 'disco', 'coluna',
  'lombar', 'cervical', 'ciatico', 'ciatica', 'nervo', 'perna', 'pernas',
  'braco', 'bracos', 'costas', 'joelho', 'ombro', 'quadril', 'pescoco',
  'cirurgia', 'exame', 'ressonancia', 'raio', 'fisioterapia', 'remedio',
  'tratamento', 'consulta', 'medico', 'sintoma', 'sintomas', 'protrusao',
  'artrose', 'bico', 'papagaio', 'travada', 'travado',
]);

/**
 * Verbos que aparecem nas perguntas que o paciente faz logo depois de a IA
 * perguntar o nome. Nenhum deles e nome de gente, e todos ja apareceram em
 * conversa real: "vcs atendem planos?", "aceita convenio?", "quanto custa?".
 */
const VERBOS_DE_PERGUNTA = new Set([
  'atende', 'atendem', 'atendeu', 'aceita', 'aceitam', 'faz', 'fazem', 'trabalha',
  'trabalham', 'custa', 'custam', 'funciona', 'funcionam', 'fica', 'ficam',
  'cobra', 'cobram', 'demora', 'demoram', 'precisa', 'precisam',
  'tem', 'teria', 'seria', 'poderia', 'consegue', 'conseguem', 'planos', 'plano',
  'convenio', 'convenios', 'particular',
]);

const STOPWORDS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'meu', 'minha', 'seu', 'sua',
  'muito', 'muita', 'muitos', 'muitas', 'pouco', 'pouca', 'poucos', 'poucas',
  'meio', 'meia', 'mais', 'menos', 'todo', 'toda', 'isso', 'aquilo', 'esse',
  'essa', 'este', 'esta', 'aqui', 'ali', 'la', 'gente', 'eu', 'voce', 'ela', 'ele',
  'vc', 'vcs', 'voces', 'voc',
  'sou', 'e', 'ser', 'esta', 'estou', 'ta', 'to', 'tem', 'tenho', 'quero',
  'queria', 'gostaria', 'preciso', 'sei', 'sinto', 'acho', 'posso', 'pode',
  'saber', 'marcar', 'agendar', 'consultar', 'com', 'sem', 'em', 'por', 'para',
  'pra', 'que', 'qual', 'quanto', 'quando', 'onde', 'como', 'nao', 'sim',
  'oi', 'ola', 'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada', 'ok',
  'dor', 'dores', 'coluna', 'hernia', 'disco', 'nervo', 'ciatico', 'ciatica',
  'consulta', 'valor', 'valores', 'preco', 'diabetico', 'diabetica', 'hipertenso',
  'hipertensa', 'obeso', 'obesa', 'corcunda', 'coucuda', 'aposentado', 'aposentada',
  'doente', 'cansado', 'cansada', 'nervoso', 'nervosa', 'operado', 'operada',
  // Viraram título de cartão pela rede de segurança em set–out/2026 (medido 19/10, rede toda):
  // "Desculpa apertei errado", "Obg", "Combinado", "Atrapalha no trabalho", "Mas hj eu tô de férias"…
  'desculpa', 'desculpe', 'obg', 'obgd', 'obgda', 'brigado', 'brigada', 'valeu', 'vlw',
  'combinado', 'beleza', 'blz', 'certo', 'entendi', 'entendido', 'perfeito', 'otimo', 'show',
  'mas', 'entao', 'assim', 'nossa', 'opa', 'ai', 'ja', 'so', 'no', 'na', 'nos', 'nas', 'me', 'se', 'te',
  'hj', 'hoje', 'agora', 'depois', 'amanha', 'ontem', 'tudo', 'parte',
  'vou', 'vamos', 'achei', 'era', 'fui', 'tinha', 'tive', 'tava', 'estava', 'atrapalha', 'manda', 'passa',
  'paciente', 'amiga', 'amigo', 'diagnosticada', 'diagnosticado', 'portadora', 'portador',
  'outra', 'outro', 'numero', 'telefone', 'celular', 'confirmo', 'cancela', 'cancelar', 'opcao', 'invalida',
  'explicando', 'endereco', 'teste', 'empresa', 'unidade', 'clinica', 'hapvida', 'radiografia', 'gluteos',
  'atendimento', 'automatico', 'cadeirante',
  'tornozelo', 'formigamentos', 'servical', 'desde', 'manha', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado',
  // "sou X" com profissão/parentesco (quem escreve não está dizendo o nome)
  'motorista', 'auxiliar', 'barbeiro', 'caminhoneiro', 'camioneiro', 'cabeleireira', 'manicure', 'diarista',
  'professora', 'professor', 'enfermeira', 'secretaria', 'doutora', 'doutor', 'assistente', 'gestora', 'gestor',
  'irmao', 'mae', 'pai', 'filha', 'esposa', 'marido', 'esposo', // 'filho' e 'irma' não: "José Filho", "Irma"
  // espanhol/inglês que aparece ("Hola buenos noches", "Soy venezolana", "mentioned you in their story")
  'hola', 'buenos', 'buenas', 'soy', 'si', 'mentioned', 'story',
  // avisos do WhatsApp/Kommo que chegam como mensagem do paciente ("Unable to display this message…",
  // "Flow responses received")
  'unable', 'flow',
]);

/** "Oiii", "Oie", "Olaaa", "kkkk", "rsrs": cumprimento e risada esticados não cabem numa lista. */
const CUMPRIMENTO_OU_RISADA = /^(o+i+e*|o+l+a+|bo+m+|k{2,}|(rs)+|(ha){2,}|(he){2,}|obr|ne)$/;

const NAME_WORD_RE = /^[a-zà-ÿ][a-zà-ÿ'\-]*$/i;

/**
 * Nome brasileiro é comprido, e o limite tem que contar os pedaços QUE IMPORTAM.
 *
 * Antes o corte era `words.length > 4` sobre as palavras cruas, e isso descartava
 * nome real: "Elzilene de Sales Dias Nogueira" (caso de produção, Imperatriz,
 * 28/08/2026) tem 5 palavras — 4 tokens de nome mais o conector "de" — e o card
 * ficou sem o nome da paciente. "Maria da Silva dos Santos" caía igual.
 *
 * Agora o teto vale sobre os tokens REAIS (conectores não contam) e a contagem
 * crua serve só de guarda contra alguém colar uma frase inteira. Quem realmente
 * separa nome de frase são as listas de queixa e de stopword — qualquer frase em
 * português esbarra numa delas.
 */
const MAX_TOKENS_REAIS = 6;
const MAX_PALAVRAS = 8;

export function looksLikeName(candidate: string): boolean {
  const cleaned = (candidate ?? '').trim();
  if (!cleaned) return false;
  if (/\d/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > MAX_PALAVRAS) return false;
  if (CONNECTORS.has(norm(words[0]))) return false;
  let tokensReais = 0;
  for (const w of words) {
    const n = norm(w);
    if (PALAVRAS_DE_QUEIXA.has(n)) return false;
    // Conector ANTES de stopword E de verbo: "e" está nas duas listas, e como
    // stopword vinha primeiro, nenhum nome com "e" no meio passava. Mesma razão
    // vale para "da" em "Maria da Silva" — sem acento ele é igual ao verbo.
    if (CONNECTORS.has(n)) continue;
    if (VERBOS_DE_PERGUNTA.has(n)) return false;
    if (STOPWORDS.has(n)) return false;
    if (CUMPRIMENTO_OU_RISADA.test(n)) return false;
    if (!NAME_WORD_RE.test(w)) return false;
    if (n.length < 2) return false;
    tokensReais++;
  }
  return tokensReais > 0 && tokensReais <= MAX_TOKENS_REAIS;
}

export function extractLeadingName(raw: string): string | null {
  const words = (raw ?? '').trim().split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    const n = norm(w);
    if (!CONNECTORS.has(n) && STOPWORDS.has(n)) break;
    if (!CONNECTORS.has(n) && !NAME_WORD_RE.test(w)) break;
    out.push(w);
    if (out.length >= MAX_PALAVRAS) break;
  }
  while (out.length && CONNECTORS.has(norm(out[out.length - 1]))) out.pop();
  const cand = out.join(' ');
  return looksLikeName(cand) ? cand : null;
}

export function askedForName(assistantMessage: string | null | undefined): boolean {
  if (!assistantMessage) return false;
  return /(como.*(te chamar|posso.*chamar)|seu nome|nome completo|qual.*nome|me (diz|conta|fala).*nome|pode.*passar.*nome)/i.test(
    assistantMessage,
  );
}

export function detectNameDisclosure(
  userMessage: string,
  opts: { nameWasAsked?: boolean } = {},
): string | null {
  const cleaned = (userMessage ?? '').trim();
  if (!cleaned) return null;

  const NAME_CHARS = "[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\\-]*";
  const TAIL = `(${NAME_CHARS}(?:\\s+${NAME_CHARS}){0,4})`;
  const patterns: RegExp[] = [
    new RegExp(`\\bmeu\\s+nome\\s+completo\\s+(?:é|eh|e)\\s+${TAIL}`, 'i'),
    new RegExp(`\\bmeu\\s+nome\\s+(?:é|eh|e)\\s+${TAIL}`, 'i'),
    new RegExp(`\\bme\\s+chamo\\s+${TAIL}`, 'i'),
    new RegExp(`\\bpode\\s+(?:me\\s+)?chamar\\s+de\\s+${TAIL}`, 'i'),
    new RegExp(`\\baqui\\s+(?:é|eh|e|quem\\s+fala\\s+é)\\s+(?:o|a)\\s+${TAIL}`, 'i'),
    // "Gilmar meu nome." / "Gilmar é o meu nome"
    new RegExp(`^${TAIL}\\s+(?:(?:é|eh|e)\\s+)?(?:o\\s+)?meu\\s+nome\\b`, 'i'),
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m && m[1]) {
      const name = extractLeadingName(m[1]);
      if (name) return name;
    }
  }

  // "sou X" é o padrão mais solto: "sou paciente", "sou auxiliar de professora", "sou motorista" viraram
  // título. Sem artigo e sem a IA ter perguntado o nome, só conta com X em maiúscula — é como a pessoa
  // escreve o próprio nome, e não a profissão. "sou a vania" / "sou o jonas" (com artigo) valem em minúscula.
  const sou = cleaned.match(new RegExp(`\\b(?:eu\\s+)?sou\\s+((?:o|a)\\s+)?${TAIL}`, 'i'));
  if (sou && sou[2] && (sou[1] || opts.nameWasAsked || /^\p{Lu}/u.test(sou[2]))) {
    const name = extractLeadingName(sou[2]);
    if (name) return name;
  }

  if (opts.nameWasAsked) {
    // Pergunta nao e nome. Caso real (Serra, 01/09/2026): a IA perguntou "como
    // posso te chamar?", a paciente respondeu "Vcs atendem planos de saude?" e
    // o cartao dela foi renomeado para "Vcs Atendem Planos 25/08/2026". O
    // paciente responder com outra pergunta e o normal, nao a excecao.
    if (cleaned.includes('?')) return null;
    // A rajada chega como uma mensagem só, uma por linha ("Olá bom dia\n\nLindalva"): o nome pode estar em qualquer uma.
    for (const linha of cleaned.split(/\n+/)) {
      const name = respostaQueEONome(linha);
      if (name) return name;
    }
  }

  return null;
}

/**
 * Depois de "como posso te chamar?", a resposta precisa SER o nome — não começar por ele.
 *
 * Antes pegávamos as primeiras palavras de qualquer resposta, e o cartão virava "Desculpa" ("Desculpa
 * apertei errado"), "Atrapalha" ("Atrapalha no trabalho"), "Já" ("Já fiz uma cirurgia…"), "Flow"
 * ("Flow responses received"): das 859 capturas da rede em 30 dias, ~350 eram frase (medido 19/10/2026).
 * Agora vale o trecho até a primeira vírgula/ponto, e ele inteiro tem que parecer nome: "Maria, tenho
 * dor" continua dando "Maria"; "Maria 😊" também (emoji sai). Número no trecho = telefone ou data.
 */
function respostaQueEONome(resposta: string): string | null {
  const trecho = resposta.split(/[,.;:!]|\s[-–—]\s/)[0] ?? '';
  if (/\d/.test(trecho)) return null;
  const limpo = trecho.replace(/[^\p{L}\p{M}'\-\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return looksLikeName(limpo) ? limpo : null;
}

export function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}
