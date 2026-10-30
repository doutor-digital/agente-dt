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
  ['Cervical', /cervic|pescoc|nuca|torcicol|braco\w* (formig|dormen|adormec)|formig\w* (no|nos) braco|\bc[1-7]-?c?[1-7]\b/],
  ['Lombar', /lombar|lombalg|coluna (baixa|lombar)|parte (de )?baixo das costas|ciatic|nervo ciatico|perna\w* (formig|dormen|adormec)|formig\w* (na|nas) perna|hernia (de disco )?l[1-5]|\bl[1-5]-?[sl][1-5]\b|quadril|bacia|gluteo|bumbum|coccix/],
  ['Torácica', /torac|dorsal|meio das costas|entre as escapul|costas e (o )?peito/],
  ['Outra', /\bombro|joelho|cotovelo|punho|tornozelo|calcanhar|\bpe\b|\bmao\b/],
];

/**
 * Deduz a região a partir da queixa. `null` = a queixa não diz (só "coluna", "costas", ou nada)
 * OU cita mais de uma região da coluna — aí quem decide é a Sofia perguntando, não o regex.
 * ("Outra" não conta como conflito: joelho + lombar é lombar.)
 */
export function classificarRegiao(queixa: string | null | undefined): Regiao | null {
  const q = normalizarTexto(queixa).trim();
  if (!q) return null;
  const casam = REGRAS.filter(([, re]) => re.test(q)).map(([r]) => r);
  const coluna = casam.filter((r) => r !== 'Outra');
  if (coluna.length > 1) return null;
  return coluna[0] ?? casam[0] ?? null;
}

export function ehCampoRegiao(nomeCampo: string): boolean {
  return /regi[aã]o da dor/i.test(nomeCampo);
}

export function ehCampoQueixa(nomeCampo: string): boolean {
  return /^\W*queixa\b/i.test(nomeCampo.trim());
}

function casarRegiao(texto: unknown): Regiao | null {
  const v = normalizarTexto(typeof texto === 'string' ? texto : '');
  return REGIOES.find((r) => normalizarTexto(r) === v) ?? null;
}

/**
 * Todas as regiões válidas do valor gravado, na ordem em que vieram. O campo é SELECT na Serra/Imperatriz
 * (valor = texto) e MULTISELECT na Timbó (valor = lista): os dois caminhos passam por aqui.
 */
export function regioesDoValor(valor: unknown): Regiao[] {
  const itens = Array.isArray(valor) ? valor : [valor];
  return itens.map(casarRegiao).filter((r): r is Regiao => r !== null);
}

/** Casa o valor gravado (com ou sem acento/caixa) com uma das opções; com lista, a primeira que casar. */
export function regiaoDoValor(valor: unknown): Regiao | null {
  return regioesDoValor(valor)[0] ?? null;
}

/**
 * Etiquetas a colocar e a tirar quando a região muda.
 * Campo multiselect com mais de uma região: vale a PRIMEIRA da lista que vira etiqueta (a Sofia lista a
 * principal primeiro), então "Torácica; Lombar" etiqueta lombar. Lombar E cervical juntas = só a primeira
 * etiqueta, a outra sai — o disparo em massa filtra por etiqueta e a pessoa não pode cair nos dois grupos.
 */
export function etiquetasDaRegiao(valor: unknown): { colocar: string | null; tirar: string[] } {
  const regiao = regioesDoValor(valor).find((r) => TAG_DA_REGIAO[r]) ?? null;
  const colocar = regiao ? TAG_DA_REGIAO[regiao] ?? null : null;
  const tirar = Object.values(TAG_DA_REGIAO).filter((t) => t !== colocar);
  return { colocar, tirar };
}
