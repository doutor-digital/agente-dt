/**
 * Região da dor: o campo que a chefe da Doutor Hérnia pediu (18/09/2026) pra separar
 * leads de cervical e de lombar e disparar mensagem certa pra cada grupo.
 *
 * Três camadas, todas automáticas:
 *  1. a Sofia grava "⚕ Região da dor" pela regra de captura (deduz das palavras; pergunta só se faltar);
 *  2. quando ela grava a Queixa e a região ainda não veio, este classificador por palavra-chave
 *     tenta deduzir (medido na Imperatriz em 18/09: resolve 2/3 das queixas);
 *  3. toda escrita do campo espelha uma etiqueta `lombar` / `cervical` no cartão, porque disparo
 *     em massa no Kommo filtra melhor por etiqueta do que por campo.
 *
 * Vocabulário casado com o da franquia (tratamentos só têm CERVICAL e LOMBAR).
 */
export const REGIOES = ['Cervical', 'Lombar', 'Torácica', 'Outra', 'Não informada'] as const;
export type Regiao = (typeof REGIOES)[number];

/** Só Cervical e Lombar viram etiqueta: são os dois grupos de disparo. */
export const TAG_DA_REGIAO: Partial<Record<Regiao, string>> = { Cervical: 'cervical', Lombar: 'lombar' };

export function normalizarTexto(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const REGRAS: Array<[Regiao, RegExp]> = [
  ['Cervical', /cervic|pescoc|nuca|torcicol|braco\w* (formig|dormen|adormec)|formig\w* (no|nos) braco|c[1-7]-?c?[1-7]\b/],
  ['Lombar', /lombar|lombalg|coluna (baixa|lombar)|parte (de )?baixo das costas|ciatic|nervo ciatico|perna\w* (formig|dormen|adormec)|formig\w* (na|nas) perna|hernia (de disco )?l[1-5]|\bl[1-5]-?[sl][1-5]\b|quadril|bacia|gluteo|bumbum|coccix/],
  ['Torácica', /torac|dorsal|meio das costas|entre as escapul|costas e (o )?peito/],
  ['Outra', /\bombro|joelho|cotovelo|punho|tornozelo|calcanhar|\bpe\b|\bmao\b/],
];

/** Deduz a região a partir da queixa. `null` = a queixa não diz (só "coluna", "costas", ou nada). */
export function classificarRegiao(queixa: string | null | undefined): Regiao | null {
  const q = normalizarTexto(queixa).trim();
  if (!q) return null;
  for (const [regiao, re] of REGRAS) if (re.test(q)) return regiao;
  return null;
}

export function ehCampoRegiao(nomeCampo: string): boolean {
  return /regi[aã]o da dor/i.test(nomeCampo);
}

export function ehCampoQueixa(nomeCampo: string): boolean {
  return /^\W*queixa\b/i.test(nomeCampo.trim());
}

/** Casa o valor gravado (com ou sem acento/caixa) com uma das opções. */
export function regiaoDoValor(valor: unknown): Regiao | null {
  const v = normalizarTexto(typeof valor === 'string' ? valor : '');
  return REGIOES.find((r) => normalizarTexto(r) === v) ?? null;
}

/** Etiquetas a colocar e a tirar quando a região muda. */
export function etiquetasDaRegiao(valor: unknown): { colocar: string | null; tirar: string[] } {
  const regiao = regiaoDoValor(valor);
  const colocar = regiao ? TAG_DA_REGIAO[regiao] ?? null : null;
  const tirar = Object.values(TAG_DA_REGIAO).filter((t) => t !== colocar);
  return { colocar, tirar };
}
