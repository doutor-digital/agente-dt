// ============================================================================
// name-capture.ts — captura e VALIDAÇÃO de nome do paciente.
//
// CONTEXTO (por que este módulo existe)
// -------------------------------------
// Um lead escreveu "...eu sou um pouco coucuda" e o extrator antigo capturou
// "um pouco coucuda" como nome, gravando isso no card do Kommo. A regra "sou X"
// era gananciosa e o único filtro rejeitava só palavras isoladas.
//
// A TRAVA (defesa em profundidade)
// --------------------------------
//   1. `looksLikeName()` — validador forte: rejeita dígitos, stopwords
//      (um, muito, pouco, dor, diabética, corcunda…), frases longas e
//      não-nomes. É o BACKSTOP usado em TODO ponto de escrita (tool do LLM
//      e rede de segurança), então nem o LLM nem a regex conseguem gravar lixo.
//   2. `extractLeadingName()` — pega só os tokens de nome do começo, parando
//      no primeiro stopword ("João e tenho dor" → "João").
//   3. `detectNameDisclosure()` — só captura quando há um padrão claro
//      ("meu nome é", "me chamo", "sou o/a X") OU quando a IA acabou de
//      perguntar o nome (captura contextual de nome "pelado").
//
// Módulo PURO (sem I/O) de propósito: dá pra testar exaustivamente sem
// subir banco, Kommo ou LangGraph.
// ============================================================================

/** Remove acentos e baixa a caixa — pra comparar com as listas. */
function norm(w: string): string {
  return w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Partículas de ligação que PODEM aparecer NO MEIO de um nome real
// (Maria DA Silva, João DOS Santos, Ana E Costa). Sozinhas ou no início,
// não são nome.
const CONNECTORS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

// Palavras que um NOME nunca é. Se qualquer token bater aqui, não é nome.
// (artigos/quantificadores, verbos comuns, saudações, termos clínicos e
// adjetivos/condições que apareceram como falso-positivo numa clínica.)
/**
 * Vocabulário de QUEIXA — nunca é nome de pessoa.
 *
 * Caso real (Imperatriz, 21/08/2026): a IA perguntou o nome, o paciente não
 * respondeu, um atendente humano entrou perguntando dos sintomas, e o paciente
 * escreveu "Fraqueza nas pernas". Como a última pergunta DA IA ainda era a do
 * nome, a captura tratou a queixa como nome e o card virou
 * "Fraqueza Nas Pernas 21/08/2026".
 *
 * Uma palavra clínica em qualquer posição já basta pra recusar: perder uma
 * captura custa uma pergunta a mais; gravar a queixa como nome estraga o card,
 * o histórico e todo tratamento que use o nome depois.
 */
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
  // artigos / quantificadores / pronomes
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'meu', 'minha', 'seu', 'sua',
  'muito', 'muita', 'muitos', 'muitas', 'pouco', 'pouca', 'poucos', 'poucas',
  'meio', 'meia', 'mais', 'menos', 'todo', 'toda', 'isso', 'aquilo', 'esse',
  'essa', 'este', 'esta', 'aqui', 'ali', 'la', 'gente', 'eu', 'voce', 'ela', 'ele',
  // verbos / ligações frequentes
  'sou', 'e', 'ser', 'esta', 'estou', 'ta', 'to', 'tem', 'tenho', 'quero',
  'queria', 'gostaria', 'preciso', 'sei', 'sinto', 'acho', 'posso', 'pode',
  'saber', 'marcar', 'agendar', 'consultar', 'com', 'sem', 'em', 'por', 'para',
  'pra', 'que', 'qual', 'quanto', 'quando', 'onde', 'como', 'nao', 'sim',
  // saudações / cortesia
  'oi', 'ola', 'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada', 'ok',
  // termos clínicos / condições (falsos-positivos numa clínica de coluna)
  'dor', 'dores', 'coluna', 'hernia', 'disco', 'nervo', 'ciatico', 'ciatica',
  'consulta', 'valor', 'valores', 'preco', 'diabetico', 'diabetica', 'hipertenso',
  'hipertensa', 'obeso', 'obesa', 'corcunda', 'coucuda', 'aposentado', 'aposentada',
  'doente', 'cansado', 'cansada', 'nervoso', 'nervosa', 'operado', 'operada',
]);

/** Só letras (com acento) e hífen/apóstrofo internos. */
const NAME_WORD_RE = /^[a-zà-ÿ][a-zà-ÿ'\-]*$/i;

/**
 * Validador FORTE. Retorna true só se `candidate` parece mesmo um nome de
 * pessoa. É o backstop de toda escrita de nome.
 */
export function looksLikeName(candidate: string): boolean {
  const cleaned = (candidate ?? '').trim();
  if (!cleaned) return false;
  if (/\d/.test(cleaned)) return false; // nome não tem número
  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false; // 1..4 palavras
  if (CONNECTORS.has(norm(words[0]))) return false; // não começa com "de/da/e…"
  let temTokenReal = false;
  for (const w of words) {
    const n = norm(w);
    // Uma palavra de queixa em qualquer posição já derruba: é resposta sobre o
    // sintoma, não apresentação. Ver PALAVRAS_DE_QUEIXA.
    if (PALAVRAS_DE_QUEIXA.has(n)) return false;
    if (STOPWORDS.has(n)) return false; // qualquer stopword → não é nome
    if (CONNECTORS.has(n)) continue; // conectores no meio são ok
    if (!NAME_WORD_RE.test(w)) return false; // caractere estranho
    if (n.length < 2) return false; // palavra de 1 letra
    temTokenReal = true;
  }
  return temTokenReal; // precisa de pelo menos 1 palavra "de verdade"
}

/**
 * Pega os tokens de nome do COMEÇO de `raw`, parando no primeiro stopword.
 * Ex: "João e tenho dor" → "João"; "um pouco coucuda" → null.
 * Retorna null se o resultado não passar no `looksLikeName`.
 */
export function extractLeadingName(raw: string): string | null {
  const words = (raw ?? '').trim().split(/\s+/);
  const out: string[] = [];
  for (const w of words) {
    const n = norm(w);
    if (STOPWORDS.has(n)) break; // para no primeiro stopword
    if (!CONNECTORS.has(n) && !NAME_WORD_RE.test(w)) break; // não-nome (número, etc.)
    out.push(w);
    if (out.length >= 4) break;
  }
  // tira conector SÓ do fim ("João e" → "João"). Conector no INÍCIO é sinal de
  // origem, não nome ("sou de imperatriz" → "de imperatriz" → rejeitado abaixo).
  while (out.length && CONNECTORS.has(norm(out[out.length - 1]))) out.pop();
  const cand = out.join(' ');
  return looksLikeName(cand) ? cand : null;
}

/** A IA acabou de pedir o nome? (última fala dela) */
export function askedForName(assistantMessage: string | null | undefined): boolean {
  if (!assistantMessage) return false;
  return /(como.*(te chamar|posso.*chamar)|seu nome|nome completo|qual.*nome|me (diz|conta|fala).*nome|pode.*passar.*nome)/i.test(
    assistantMessage,
  );
}

/**
 * Extrai o nome do paciente da mensagem dele. Retorna null se não houver
 * captura segura (o padrão — evita falso-positivo).
 *
 * Captura quando:
 *   • há padrão explícito: "meu nome é X", "me chamo X", "sou o/a X",
 *     "aqui é o/a X", "pode me chamar de X"; OU
 *   • `opts.nameWasAsked` é true (a IA acabou de perguntar) e a mensagem
 *     inteira parece um nome.
 * Em ambos os casos o candidato ainda passa por `extractLeadingName`/`looksLikeName`.
 */
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
    new RegExp(`\\b(?:eu\\s+)?sou\\s+(?:o|a)\\s+${TAIL}`, 'i'), // "sou A Ana" (com artigo)
    new RegExp(`\\b(?:eu\\s+)?sou\\s+${TAIL}`, 'i'), // "sou João" — validado depois
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m && m[1]) {
      const name = extractLeadingName(m[1]);
      if (name) return name;
    }
  }

  // Captura contextual: a IA acabou de perguntar o nome e o lead respondeu
  // com o que parece ser um nome "pelado" (ex: "Edna Evangelista Cardoso").
  if (opts.nameWasAsked) {
    const name = extractLeadingName(cleaned);
    if (name) return name;
  }

  return null;
}

/** Capitaliza cada palavra do nome (ex: "joão silva" → "João Silva"). */
export function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}
