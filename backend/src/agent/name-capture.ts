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

export function looksLikeName(candidate: string): boolean {
  const cleaned = (candidate ?? '').trim();
  if (!cleaned) return false;
  if (/\d/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  if (CONNECTORS.has(norm(words[0]))) return false;
  let temTokenReal = false;
  for (const w of words) {
    const n = norm(w);
    if (PALAVRAS_DE_QUEIXA.has(n)) return false;
    if (STOPWORDS.has(n)) return false;
    if (CONNECTORS.has(n)) continue;
    if (!NAME_WORD_RE.test(w)) return false;
    if (n.length < 2) return false;
    temTokenReal = true;
  }
  return temTokenReal;
}

export function extractLeadingName(raw: string): string | null {
  const words = (raw ?? '').trim().split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    const n = norm(w);
    if (STOPWORDS.has(n)) break;
    if (!CONNECTORS.has(n) && !NAME_WORD_RE.test(w)) break;
    out.push(w);
    if (out.length >= 4) break;
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
