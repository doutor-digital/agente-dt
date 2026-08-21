// ============================================================================
// guardrail.ts — TRAVA DURA pós-LLM sobre o texto final da IA.
//
// Prompt é sugestão; sob insistência o modelo cede. Este guardrail é
// DETERMINÍSTICO (regex, custo ~zero, sem round-trip) e roda no ponto único
// por onde as 3 entregas passam (graph.ts → decision). Duas travas:
//
//   1. PREÇO — bloqueia valor R$ que NÃO está no catálogo da unidade
//      (campos "Fontes": source_produtos = "valores permitidos"). Parcela
//      plausível de um valor aprovado é aceita. Se a unidade não tem preço
//      cadastrado, a trava fica off (fail-open, nunca inventa bloqueio).
//
//   2. CLÍNICO (só category = "saude") — bloqueia diagnóstico, prescrição,
//      garantia de cura e promessa de "sem cirurgia". A IA vende a consulta,
//      não opina sobre o caso — quem avalia é o profissional, presencialmente.
//
// Quando dispara, troca a mensagem inteira por um fallback seguro e on-brand
// (reescrever frase a frase arrisca deixar a resposta incoerente). O disparo
// é sempre logado no trace pra aparecer no painel.
// ============================================================================

import type { Unit } from '@prisma/client';

export interface GuardrailResult {
  /** Texto a entregar — reescrito quando `rewritten` é true, senão o original. */
  text: string;
  /** Regras que dispararam, ex.: ["clinico:prescricao"] ou ["preco:200"]. */
  triggered: string[];
  /** Se a mensagem original foi substituída pelo fallback. */
  rewritten: boolean;
}

// Extrai valores R$ de textos: aceita "R$ 1.500,00", "R$350", "R$ 150".
function parseAmounts(...texts: (string | null | undefined)[]): Set<number> {
  const set = new Set<number>();
  const re = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;
  for (const t of texts) {
    if (!t) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const n = Number(m[1].replace(/\./g, ''));
      if (!Number.isNaN(n) && n > 0) set.add(n);
    }
  }
  return set;
}

// Aprovado = está no catálogo OU é parcela plausível de um valor do catálogo.
function amountApproved(v: number, approved: Set<number>): boolean {
  if (approved.has(v)) return true;
  for (const total of approved) {
    for (let n = 2; n <= 12; n++) {
      if (Math.abs(Math.round(total / n) - v) <= 2) return true; // tolera arredondamento
    }
  }
  return false;
}

const FALLBACK_PRECO =
  'Sobre o valor, deixa eu confirmar certinho pra não te passar informação errada 🙏 ' +
  'Me conta rapidinho: qual é o seu incômodo e onde está doendo? Aí já te oriento sobre a avaliação.';

const FALLBACK_CLINICO =
  'Sobre o que você está sentindo, quem avalia com segurança é a nossa especialista, na consulta — ' +
  'por aqui eu não consigo dar um diagnóstico. Vamos garantir sua avaliação? 😊';

// Coisas que a IA de saúde NUNCA deve afirmar.
const REGRAS_CLINICAS: { key: string; re: RegExp }[] = [
  {
    key: 'diagnostico',
    re: /\bvoc[eê]\s+(tem|est[aá]\s+com|apresenta|possui)\b[^.!?]{0,40}\b(h[eé]rnia|protrus|abaulament|b[ií]co de papagaio|artrose|ci[aá]tica|estenose|les[aã]o|inflama)/i,
  },
  {
    key: 'prescricao',
    re: /\b(tom[ae]|tomar|us[ae]|usar|utilize|receit)\w*\b[^.!?]{0,45}\b(rem[eé]dio|medicament|anti[- ]?inflamat|analg[eé]sic|relaxante|comprimido|pomada|dipirona|ibuprofen|nimesulida|cortic|inje[cç]|infiltra)/i,
  },
  {
    key: 'garantia_cura',
    re: /\b(garant|com certeza|100\s*%|certamente|prometo)\w*\b[^.!?]{0,40}\b(cur[ao]|sar[ae]|resolv|melhora|fica bom|sem dor)/i,
  },
  {
    key: 'promessa_sem_cirurgia',
    re: /\bn[aã]o\s+(vai\s+)?precis\w*\s+(de\s+|fazer\s+)?(cirurgia|opera[cç])/i,
  },
  {
    key: 'minimiza_sintoma',
    re: /\bn[aã]o\s+[eé]\s+nada\s+(grave|s[eé]rio|demais)/i,
  },
];

/**
 * Aplica o guardrail no texto final da IA. Puro e síncrono — o log fica a cargo
 * de quem chama (tem o `recorder` em mãos). Retorna sempre um texto seguro.
 */
export function aplicarGuardrail(text: string, unit: Unit): GuardrailResult {
  if (!text || !text.trim()) return { text, triggered: [], rewritten: false };
  const triggered: string[] = [];

  // 1) CLÍNICO — só em unidades de saúde.
  if (unit.category?.trim() === 'saude') {
    for (const regra of REGRAS_CLINICAS) {
      if (regra.re.test(text)) triggered.push('clinico:' + regra.key);
    }
    if (triggered.length > 0) {
      return { text: FALLBACK_CLINICO, triggered, rewritten: true };
    }
  }

  // 2) PREÇO fora do catálogo da unidade.
  const aprovados = parseAmounts(unit.sourceProdutos, unit.sourcePapel, unit.sourceNegocio);
  if (aprovados.size > 0) {
    const foraDoCatalogo = [...parseAmounts(text)].filter(
      (v) => v >= 20 && !amountApproved(v, aprovados),
    );
    if (foraDoCatalogo.length > 0) {
      triggered.push('preco:' + foraDoCatalogo.join('/'));
      return { text: FALLBACK_PRECO, triggered, rewritten: true };
    }
  }

  return { text, triggered, rewritten: false };
}
