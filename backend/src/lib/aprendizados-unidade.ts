/**
 * Aprendizados escritos pela PRÓPRIA unidade (página pública `/aprendizados/:slug`, com o código da unidade).
 * Pedido de 11/11/2026: a dona de Timbó ajusta a Sofia sem depender do João. A regra entra no bloco
 * `<aprendizados>` do prompt (`renderLessons`), como as do painel.
 *
 * Aqui moram as TRAVAS que a unidade não desliga — o texto é recusado antes de gravar quando mexe em:
 *  - pronto-socorro (a Sofia nunca sugere — decisão de 26/10);
 *  - sinal de alerta (força na perna, xixi, fezes, virilha, febre, emergência): é regra da rede, só o João muda;
 *  - promessa de cura ou de resultado;
 *  - preço, desconto, brinde, parcelamento (só a equipe muda o valor, no cadastro);
 *  - diagnóstico ou remédio.
 * Frase que NEGA o tema ("nunca prometa cura", "não dê desconto") passa: ela reforça a regra da rede.
 * Sinal de alerta e pronto-socorro não têm exceção nem com negação — qualquer ajuste ali é com o João.
 */

export const CHAVE_APRENDIZADOS = 'aprendizados-pela-unidade';
export const SOURCE_DA_UNIDADE = 'unidade';
export const MIN_CARACTERES = 10;
export const MAX_CARACTERES = 400;
/** Regras ligadas escritas pela unidade: acima disso, ela desliga uma antes de criar outra (o prompt não incha). */
export const MAX_REGRAS_DA_UNIDADE = 25;
/** Prévias por unidade por dia (cada prévia roda o modelo 2× por fala de exemplo). */
export const MAX_PREVIAS_POR_DIA = 10;
export const MAX_FALAS_DA_PREVIA = 3;

export const FALAS_DE_EXEMPLO = [
  'Oi, boa tarde! Quanto custa a consulta?',
  'Tenho hérnia de disco faz 2 anos, dói muito pra sentar. Vocês tratam?',
  'Vou ver com meu marido e depois te falo.',
] as const;

const NEGACAO = /\b(?:n[aã]o|nunca|jamais|nem|evite|evitar|proibido)\b|\bsem (?:prometer|garantir|falar|dar|oferecer|indicar|citar)\b/i;

/** Temas que nem com negação passam: a regra da rede é fixa e o ajuste é com o João. */
const SEMPRE_RECUSA: Array<{ re: RegExp; motivo: string }> = [
  {
    re: /pronto[\s-]*(socorro|atendimento)|\bUPA\b|\bSAMU\b|hospital/i,
    motivo: 'Pronto-socorro e hospital são regra da rede: a Sofia nunca sugere. Esse ajuste é só com o João.',
  },
  {
    re: /sina(?:l|is) de alerta|red ?flag|bandeira vermelha|emerg[eê]ncia|for[cç]a (?:na|nas) perna|perd\w* (?:de )?for[cç]a|xixi|urin|fezes|esf[ií]ncter|virilha|febre|\bsela\b/i,
    motivo:
      'Sinal de alerta (força na perna, xixi, fezes, virilha, febre, emergência) é regra da rede e protege o paciente. Esse ajuste é só com o João.',
  },
];

/** Temas que passam só quando a frase NEGA (reforça a regra da rede). */
const RECUSA_SEM_NEGACAO: Array<{ re: RegExp; motivo: string }> = [
  {
    re: /\bcura\b|\bcurar\b|\bcuramos\b|\bsara[rm]?\b|garant\w* (?:de |a |o )?(?:cura|resultado|melhora)|resultado (?:garantido|certo)|100\s?%|resolve de vez|nunca mais (?:vai )?(?:sentir|doer)/i,
    motivo: 'A Sofia não promete cura nem resultado. Escreva a regra sem prometer resultado.',
  },
  {
    re: /R\$\s*\d|\d+\s*reais|descont|gr[aá]tis|gratuit|de gra[cç]a|cupom|promo[cç]|parcel|brinde|pre[cç]o (?:novo|diferente|menor)|baixar o (?:pre[cç]o|valor)/i,
    motivo: 'Valor, desconto e parcelamento não mudam por aqui: a equipe muda no cadastro da unidade.',
  },
  {
    re: /diagnostiqu|diagnosticar|d[eê] (?:o |um )?diagn[oó]stico|receite|receitar|(?:indique|indicar|recomende|recomendar|sugira|sugerir|tome|tomar) (?:um |o |algum )?(?:rem[eé]dio|medicamento|anti)|anti-?inflamat|dipirona|relaxante muscular/i,
    motivo: 'A Sofia não diagnostica nem indica remédio. Escreva a regra sem isso.',
  },
];

/** Uma frase por vez: "Ofereça horário logo. Não prometa cura." tem duas, e a negação de uma não salva a outra. */
function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.!?;\n])\s+|\n+/)
    .map((f) => f.trim())
    .filter(Boolean);
}

/** `null` = pode gravar. Senão, o motivo em português simples, para a página mostrar. */
export function recusaDaRegra(textoBruto: string): string | null {
  const texto = textoBruto.trim();
  if (texto.length < MIN_CARACTERES) return `Escreva a regra com pelo menos ${MIN_CARACTERES} letras.`;
  if (texto.length > MAX_CARACTERES) return `Regra longa demais: até ${MAX_CARACTERES} letras. Divida em duas.`;
  if (/<\/?[a-z_]+>/i.test(texto)) return 'Escreva só o texto da regra, sem marcações entre < >.';
  for (const s of SEMPRE_RECUSA) if (s.re.test(texto)) return s.motivo;
  for (const frase of frases(texto)) {
    for (const s of RECUSA_SEM_NEGACAO) {
      if (s.re.test(frase) && !NEGACAO.test(frase)) return s.motivo;
    }
  }
  return null;
}

/** Limpa o que a pessoa colou: espaços repetidos e linhas vazias. A palavra dela fica como está. */
export function normalizarRegra(texto: string): string {
  return texto
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// ── teto de prévias por unidade por dia (memória do processo; reinício zera, o que só dá folga) ──
const previas = new Map<string, { dia: string; n: number }>();

function diaDe(agora: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

/** Conta uma prévia e diz se ainda cabe hoje. */
export function cabePrevia(slug: string, tz: string, agora: Date = new Date()): boolean {
  const dia = diaDe(agora, tz);
  const p = previas.get(slug);
  if (!p || p.dia !== dia) {
    previas.set(slug, { dia, n: 1 });
    return true;
  }
  if (p.n >= MAX_PREVIAS_POR_DIA) return false;
  p.n += 1;
  return true;
}

/** Prévias que restam hoje (para a página mostrar). */
export function previasRestantes(slug: string, tz: string, agora: Date = new Date()): number {
  const p = previas.get(slug);
  if (!p || p.dia !== diaDe(agora, tz)) return MAX_PREVIAS_POR_DIA;
  return Math.max(0, MAX_PREVIAS_POR_DIA - p.n);
}

/** Só para teste. */
export function zerarPrevias(): void {
  previas.clear();
}
