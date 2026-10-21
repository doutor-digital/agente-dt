/**
 * Duas coisas que escapam do modelo e não deveriam chegar ao paciente nunca (lista de Marabá, 21/10/2026):
 *
 *  - PALAVRA EM INGLÊS no meio da frase. Lead 28466712 (19/10): "você sente algo nas costas também, ou é only o
 *    joelho mesmo?". O vazamento.ts segura raciocínio inteiro em inglês ("let me check…"), mas uma palavra solta
 *    passa — e segurar a mensagem por causa dela seria pior que trocar a palavra.
 *  - "JÁ TE EXPLIQUEI". Lead 28253300 (16/10): a paciente perguntou "Qual o valor da sessão?" e ouviu "Já te
 *    expliquei certo, Dária: a consulta é R$ 350…". Pergunta repetida se responde de novo, sem cobrar.
 *
 * As duas se corrigem em código, sem chamar o modelo de novo: a palavra vira a portuguesa e a abertura que cobra
 * sai, ficando o resto da frase. Lista fechada de propósito — "ok", "online", "e-mail", "check-up" são do
 * português do dia a dia e ficam.
 */

const INGLES: Record<string, string> = {
  only: 'só',
  just: 'só',
  also: 'também',
  maybe: 'talvez',
  already: 'já',
  still: 'ainda',
  really: 'mesmo',
  actually: 'na verdade',
  because: 'porque',
  however: 'porém',
  anyway: 'enfim',
};

// fim de palavra à mão: o \b do JS não enxerga letra acentuada como letra
const PALAVRA_EM_INGLES = new RegExp(String.raw`(?<![\wÀ-ÿ'’-])(${Object.keys(INGLES).join('|')})(?![\wÀ-ÿ'’-])`, 'gi');
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

/**
 * "Já te expliquei certo, Dária:", "Como eu disse,", "Já te falei que" — no começo de uma frase. O nome depois da
 * vírgula também sai (é o vocativo da cobrança).
 */
const COBRANCA = new RegExp(
  String.raw`(^|[.!?…]\s+|\n\s*)` +
    String.raw`(?:como\s+(?:eu\s+)?(?:j[aá]\s+)?(?:te\s+|lhe\s+)?(?:disse|falei|expliquei|mencionei|comentei)|` +
    String.raw`j[aá]\s+(?:te\s+|lhe\s+)?(?:disse|falei|expliquei|mencionei|comentei))` +
    String.raw`(?:\s+(?:isso|antes|acima|anteriormente|certo|certinho))*` +
    String.raw`(?:\s*,\s*[A-ZÀ-Ý][a-zà-ÿ]+)?` +
    String.raw`(?:\s*[:,;—–-]\s*|\s+que\s+)`,
  'gi',
);

function primeiraMaiuscula(s: string): string {
  return s.replace(/^(\s*)(\p{Ll})/u, (_, esp: string, l: string) => esp + l.toUpperCase());
}

function trocarIngles(trecho: string, trocas: string[]): string {
  return trecho.replace(PALAVRA_EM_INGLES, (palavra: string) => {
    const pt = INGLES[palavra.toLowerCase()];
    trocas.push(`ingles:${palavra.toLowerCase()}`);
    return palavra[0] === palavra[0].toUpperCase() ? primeiraMaiuscula(pt) : pt;
  });
}

export function corrigirTomDaSaida(texto: string): { texto: string; trocas: string[] } {
  const trocas: string[] = [];
  // link fica como está (um "only" num endereço de mapa não é fala)
  let out = '';
  let ultimo = 0;
  for (const m of texto.matchAll(URL)) {
    const ini = m.index ?? 0;
    out += trocarIngles(texto.slice(ultimo, ini), trocas) + m[0];
    ultimo = ini + m[0].length;
  }
  out += trocarIngles(texto.slice(ultimo), trocas);

  out = out.replace(COBRANCA, (_m, antes: string, pos: number, todo: string) => {
    trocas.push('ja_expliquei');
    // a letra que vem depois sobe para maiúscula: começa frase agora
    const resto = todo.slice(pos + _m.length);
    return antes + (/^\p{Ll}/u.test(resto) ? '\u0000' : '');
  });
  out = out.replace(/\u0000(\p{Ll})/gu, (_, l: string) => l.toUpperCase());

  return { texto: out, trocas };
}
