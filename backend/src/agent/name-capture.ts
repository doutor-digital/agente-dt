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

const STOPWORDS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'meu', 'minha', 'seu', 'sua',
  'muito', 'muita', 'muitos', 'muitas', 'pouco', 'pouca', 'poucos', 'poucas',
  'meio', 'meia', 'mais', 'menos', 'todo', 'toda', 'isso', 'aquilo', 'esse',
  'essa', 'este', 'esta', 'aqui', 'ali', 'la', 'gente', 'eu', 'voce', 'ela', 'ele',
  'sou', 'e', 'ser', 'esta', 'estou', 'ta', 'to', 'tem', 'tenho', 'quero',
  'queria', 'gostaria', 'preciso', 'sei', 'sinto', 'acho', 'posso', 'pode',
  'saber', 'marcar', 'agendar', 'consultar', 'com', 'sem', 'em', 'por', 'para',
  'pra', 'que', 'qual', 'quanto', 'quando', 'onde', 'como', 'nao', 'sim',
  'oi', 'ola', 'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada', 'ok',
  'dor', 'dores', 'coluna', 'hernia', 'disco', 'nervo', 'ciatico', 'ciatica',
  'consulta', 'valor', 'valores', 'preco', 'diabetico', 'diabetica', 'hipertenso',
  'hipertensa', 'obeso', 'obesa', 'corcunda', 'coucuda', 'aposentado', 'aposentada',
  'doente', 'cansado', 'cansada', 'nervoso', 'nervosa', 'operado', 'operada',
]);

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
    // Conector ANTES de stopword: "e" está nas duas listas, e como stopword vinha
    // primeiro, nenhum nome com "e" no meio passava.
    if (CONNECTORS.has(n)) continue;
    if (STOPWORDS.has(n)) return false;
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
    new RegExp(`\\b(?:eu\\s+)?sou\\s+(?:o|a)\\s+${TAIL}`, 'i'),
    new RegExp(`\\b(?:eu\\s+)?sou\\s+${TAIL}`, 'i'),
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m && m[1]) {
      const name = extractLeadingName(m[1]);
      if (name) return name;
    }
  }

  if (opts.nameWasAsked) {
    const name = extractLeadingName(cleaned);
    if (name) return name;
  }

  return null;
}

export function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}
