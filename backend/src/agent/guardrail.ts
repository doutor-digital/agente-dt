import type { Unit } from '@prisma/client';

export interface GuardrailResult {
  text: string;
  triggered: string[];
  rewritten: boolean;
}

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

function amountApproved(v: number, approved: Set<number>): boolean {
  if (approved.has(v)) return true;
  for (const total of approved) {
    for (let n = 2; n <= 12; n++) {
      if (Math.abs(Math.round(total / n) - v) <= 2) return true;
    }
  }
  return false;
}

const FALLBACK_PRECO =
  'Sobre o valor, deixa eu confirmar certinho pra não te passar informação errada 🙏 ' +
  'Já te falo por aqui, tá bem?';

/**
 * Troca cada valor fora do catálogo pelo valor aprovado mais próximo.
 *
 * Antes daqui, um preço errado derrubava a mensagem INTEIRA. Isso custou caro:
 * em 14 dias foram 176 bloqueios em 10 unidades, e 7 deles eram confirmação de
 * agendamento — o paciente marcava a consulta e recebia de volta uma pergunta
 * de triagem, sem data, sem endereço e sem PIX. O número errado era um detalhe
 * numa mensagem inteira que estava certa.
 *
 * Escolhe o aprovado mais próximo, pulando os que já aparecem na mensagem, pra
 * não produzir "R$ 350 no PIX à vista (ou R$ 350)". Se sobrar valor sem
 * substituto, devolve null e quem chama cai no texto de segurança.
 */
function corrigirValores(
  text: string,
  aprovados: Set<number>,
  foraDoCatalogo: number[],
): { texto: string; trocas: string[] } | null {
  const jaNoTexto = new Set(
    [...parseAmounts(text)].filter((v) => amountApproved(v, aprovados)),
  );
  const alvo = new Set(foraDoCatalogo);
  const trocas: string[] = [];
  let semSubstituto = false;

  // Uma varredura só, com o mesmo formato que detectou os valores — assim
  // "R$ 200," "R$ 200,00" e "R$ 1.500" são tratados igual.
  const re = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;
  const texto = text.replace(re, (match, num: string) => {
    const v = Number(num.replace(/\./g, ''));
    if (!alvo.has(v)) return match;

    const certo = [...aprovados]
      .filter((a) => !jaNoTexto.has(a))
      .sort((a, b) => Math.abs(a - v) - Math.abs(b - v))[0];
    if (certo === undefined) {
      semSubstituto = true;
      return match;
    }
    jaNoTexto.add(certo);
    trocas.push(`${v}→${certo}`);
    return `R$ ${certo}`;
  });

  if (semSubstituto || trocas.length === 0) return null;
  return { texto, trocas };
}

const FALLBACK_CLINICO =
  'Sobre o que você está sentindo, quem avalia com segurança é a nossa especialista, na consulta — ' +
  'por aqui eu não consigo dar um diagnóstico. Vamos garantir sua consulta? 😊';

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

export function aplicarGuardrail(text: string, unit: Unit): GuardrailResult {
  if (!text || !text.trim()) return { text, triggered: [], rewritten: false };
  const triggered: string[] = [];

  if (unit.category?.trim() === 'saude') {
    for (const regra of REGRAS_CLINICAS) {
      if (regra.re.test(text)) triggered.push('clinico:' + regra.key);
    }
    if (triggered.length > 0) {
      return { text: FALLBACK_CLINICO, triggered, rewritten: true };
    }
  }

  const aprovados = parseAmounts(unit.sourceProdutos, unit.sourcePapel, unit.sourceNegocio);
  if (aprovados.size > 0) {
    const foraDoCatalogo = [...parseAmounts(text)].filter(
      (v) => v >= 20 && !amountApproved(v, aprovados),
    );
    if (foraDoCatalogo.length > 0) {
      const corrigido = corrigirValores(text, aprovados, foraDoCatalogo);
      if (corrigido) {
        triggered.push('preco_corrigido:' + corrigido.trocas.join('/'));
        return { text: corrigido.texto, triggered, rewritten: true };
      }
      triggered.push('preco:' + foraDoCatalogo.join('/'));
      return { text: FALLBACK_PRECO, triggered, rewritten: true };
    }
  }

  return { text, triggered, rewritten: false };
}
