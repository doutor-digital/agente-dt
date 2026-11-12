/**
 * Trava de vazamento da conversa de teste pública (`/aprendizados/:slug`). Decisão do João, 12/11/2026: quem tem o código da
 * unidade conversa com o prompt REAL da Sofia, e não pode usar a conversa para ler o texto dela (prompt da rede e da unidade,
 * regras, base de conhecimento). Duas portas, as duas heurísticas e as duas de reforço uma da outra:
 *  1. ENTRADA (`pedeOPrompt`): fala que pede instruções/prompt/regras, "ignore as regras", papel de sistema ou marcação de bloco
 *     é recusada ANTES do modelo, sem gastar cota nem dinheiro;
 *  2. SAÍDA (`ecoDoPrompt`): se a resposta repete trecho longo do prompt (80+ letras seguidas) ou marcador de bloco do prompt,
 *     troca por resposta neutra (a chamada já custou: conta na cota).
 * Não cobre pedido disfarçado (tradução, base64, "resuma") que devolva o conteúdo com outras palavras: é redução de risco, não
 * garantia. O texto das regras que a unidade escreve não é segredo dela; o que se protege é o da rede e o da base.
 */

export const RECUSA_DA_ENTRADA = 'No teste, escreva como o paciente escreveria.';
export const RESPOSTA_NEUTRA = 'Não consegui responder isso aqui no teste. Escreva como o paciente escreveria.';
/** Trecho literal do prompt que, repetido na resposta, bloqueia (depois de normalizar espaço e caixa). */
export const JANELA_DO_ECO = 80;
/** Passo da varredura da saída: um trecho literal de JANELA_DO_ECO + PASSO - 1 letras seguidas é sempre achado. */
const PASSO = 4;

/** Sem acento, caixa baixa, sinal vira espaço (mantém < > / para marcação), espaço único. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9<>/\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A pessoa fala da Sofia ("suas regras", "seu prompt"), do texto interno ou do que "te disseram". */
const ALVO_INTERNO = [
  /\b(?:system|sistema)\s*(?:prompt|message|mensagem)\b/,
  /\bprompts?\b/,
  /\b(?:suas?|seus?|tuas?|teus?)\s+(?:\w+\s+)?(?:instrucoes|instrucao|regras|diretrizes|configuracoes|ordens|comandos|prompts?|treinamento|programacao|base de conhecimento)\b/,
  /\b(?:instrucoes|instrucao|regras|diretrizes|orientacoes|configuracoes|ordens|comandos|treinamento|programacao)\s+(?:internas?|iniciais|ocultas?|secretas?|do sistema|de sistema|da rede|da ia|da sofia|que (?:voce|vc|te|lhe) (?:recebeu|deram|passaram|mandaram|foram dadas))\b/,
  /\bo que (?:te|lhe|voce|vc) (?:disseram|falaram|pediram|mandaram|programaram|passaram|foi dito|foi pedido|recebeu|configuraram|ensinaram)\b/,
  /\b(?:texto|tudo|conteudo)\s+(?:que esta\s+)?(?:acima|do inicio da conversa)\b/,
  /\b(?:repita|repete|mostre|mostra|copie|cole|reproduza|transcreva|diga|escreva|liste|exiba)\s+(?:\w+\s+){0,4}(?:inicio|comeco|primeira mensagem)\s+(?:da|desta|dessa|de)\s+(?:conversa|chat|sessao|contexto)\b/,
  /\b(?:como|de que jeito|por que|porque|quem)\s+(?:voce|vc)\s+(?:foi|e|esta)\s+(?:programad|configurad|instruid|treinad|criad)/,
  /\bsystem\b/,
  /\bdeveloper\s*(?:message|mensagem|mode|modo)\b/,
];

/** "ignore as regras", "esqueça tudo", "a partir de agora você é…", modos especiais. */
const INJECAO = [
  /\b(?:ignore|ignora|ignorar|ignorem|desconsidere|desconsiderar|esqueca|descarte|abandone|desobedeca|burle|contorne)\s+(?:\w+\s+){0,3}(?:regras?|instrucoes|instrucao|orientacoes|diretrizes|anterior|anteriores|acima|tudo|prompt|restricoes|limites|filtros?|treinamento)\b/,
  /\b(?:a partir (?:de )?agora|de agora em diante)\s+(?:voce|vc)\s+(?:e|sera|vai ser|deve|nao|obedece|age|atua|responde|fala)\b/,
  /\b(?:finja|simule|aja|atue|interprete|incorpore|assuma o papel)\s+(?:como|de|que)\s+(?:se\s+)?(?:voce\s+)?(?:fosse|e|sendo)?\s*(?:um|uma|o|a)?\s*(?:ia|assistente|programador|desenvolvedor|administrador|admin|dev|hacker|sistema|outro|outra|robo sem|chatbot sem)\b/,
  /\bmodo\s+(?:desenvolvedor|dev|admin|administrador|debug|deus|livre|sem filtro|manutencao|teste interno)\b/,
  /\b(?:jailbreak|dan mode|prompt injection|sem censura)\b/,
  /\b(?:revele|vaze|divulgue|exponha|exiba|mostre|imprima|copie|cole|repita|reproduza|transcreva|traduza)\s+(?:\w+\s+){0,4}(?:instrucoes|regras|prompt|diretrizes|configuracao|configuracoes|base de conhecimento|conhecimento interno|informacoes internas|dados internos|bastidores)\b.*\b(?:voce|vc|sofia|sistema|rede|ia|interno|internas?|internos?|completo|completa|inteiro|inteira|literal|palavra por palavra)\b/,
];

/** Marcação de bloco ou de papel digitada: `<aprendizados>`, `</x>`, `[system]`, `### system`. */
const MARCACAO = [/<\/?\s*[a-z_][a-z0-9_-]*\s*>?/];
const MARCACAO_BRUTA = /\[\s*(?:system|sistema|assistant|inst)\s*\]|#{1,6}\s*(?:system|sistema|instru)/i;

/** `true` = a fala quer o texto interno da Sofia (ou desligar as regras): recusar antes do modelo. */
export function pedeOPrompt(fala: string): boolean {
  const n = normalizar(fala);
  if (!n) return false;
  if (ALVO_INTERNO.some((re) => re.test(n))) return true;
  if (INJECAO.some((re) => re.test(n))) return true;
  if (MARCACAO.some((re) => re.test(n)) || MARCACAO_BRUTA.test(fala)) return true;
  // letras separadas ("p r o m p t", "s.y.s.t.e.m"): confere de novo sem nenhum espaço, só para as palavras mais óbvias
  const colado = n.replace(/[^a-z]/g, '');
  if (/systemprompt|systemmessage|promptdosistema|meuprompt|seuprompt|ignoreasregras|ignoretudo/.test(colado)) return true;
  // sequência de 4+ letras soltas ("p r o m p t"): cola só ela e procura a palavra
  for (const m of n.matchAll(/(?:^| )((?:[a-z](?: |$)){4,})/g)) {
    if (/prompt|system|instrucoes|regras|ignore/.test(m[1].replace(/ /g, ''))) return true;
  }
  return false;
}

const ESPACOS = /\s+/g;

function colar(texto: string): string {
  return texto.toLowerCase().replace(ESPACOS, ' ').trim();
}

/** Nomes dos blocos `<nome>` que o prompt usa (`<aprendizados>`, `<conversa_direta>`…): na resposta, só o prompt os escreveria. */
function blocosDoPrompt(prompt: string): string[] {
  const nomes = new Set<string>();
  for (const m of prompt.matchAll(/<([a-zA-Z_][a-zA-Z0-9_-]{3,})[\s>]/g)) nomes.add(m[1].toLowerCase());
  return [...nomes];
}

/** Marcadores fixos que só existem no prompt (caixa exata: "SEU NOME:" em maiúsculas). */
const MARCADORES_FIXOS = ['SEU NOME:', '# CONTEXTO DE TESTE'];

/**
 * `true` = a resposta repete o prompt: trecho literal de `JANELA_DO_ECO`+ letras (espaço e caixa não contam), marcador de
 * bloco do prompt ou marcador fixo. Sem prompt (nunca deve acontecer) = bloqueia: quem chama decide, aqui falha fechado.
 */
export function ecoDoPrompt(resposta: string, prompt: string | undefined): boolean {
  if (!prompt) return true;
  if (!resposta.trim()) return false;
  if (MARCADORES_FIXOS.some((m) => resposta.includes(m) && prompt.includes(m))) return true;
  const baixa = resposta.toLowerCase();
  for (const bloco of blocosDoPrompt(prompt)) {
    if (baixa.includes(`<${bloco}`) || baixa.includes(`</${bloco}`)) return true;
  }
  const p = colar(prompt);
  const r = colar(resposta);
  if (r.length < JANELA_DO_ECO) return false;
  for (let i = 0; i + JANELA_DO_ECO <= r.length; i += PASSO) {
    if (p.includes(r.slice(i, i + JANELA_DO_ECO))) return true;
  }
  // a última janela inteira (o passo pode ter pulado o fim)
  return p.includes(r.slice(-JANELA_DO_ECO));
}
