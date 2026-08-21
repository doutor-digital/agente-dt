const DESVIO_TIPICO = 1.5;
const Z_95 = 1.96;

export type NivelConfianca = 'insuficiente' | 'indicativo' | 'confiavel';

export interface Confianca {
  n: number;
  nivel: NivelConfianca;
  margemErro: number;
  explicacao: string;
}

export function confiancaDaMedia(n: number): Confianca {
  const amostra = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const margemErro = amostra > 0 ? (Z_95 * DESVIO_TIPICO) / Math.sqrt(amostra) : Infinity;

  if (amostra < 12) {
    return {
      n: amostra,
      nivel: 'insuficiente',
      margemErro: amostra > 0 ? arredonda(margemErro) : 0,
      explicacao:
        amostra === 0
          ? 'Ainda sem conversas avaliadas — a nota aparece quando as primeiras forem analisadas.'
          : `Poucas conversas avaliadas (${amostra}). A nota ainda oscila muito; espere chegar a 12 pra tirar conclusão.`,
    };
  }
  if (amostra < 40) {
    return {
      n: amostra,
      nivel: 'indicativo',
      margemErro: arredonda(margemErro),
      explicacao: `${amostra} conversas avaliadas — já dá uma boa ideia, mas só diferenças grandes (acima de ${arredonda(margemErro * 2)} ponto) são reais.`,
    };
  }
  return {
    n: amostra,
    nivel: 'confiavel',
    margemErro: arredonda(margemErro),
    explicacao: `${amostra} conversas avaliadas — amostra sólida. Diferenças acima de ${arredonda(margemErro * 2)} ponto são reais.`,
  };
}

export interface Versao {
  rotulo: string;
  media: number;
  n: number;
}

export interface Comparacao {
  vencedora: string | null;
  diferenca: number;
  conclusivo: boolean;
  explicacao: string;
}

export function compararVersoes(a: Versao, b: Versao): Comparacao {
  const diferenca = arredonda(Math.abs(a.media - b.media));
  const melhor = a.media >= b.media ? a : b;
  const pior = a.media >= b.media ? b : a;

  if (a.n < 12 || b.n < 12) {
    return {
      vencedora: null,
      diferenca,
      conclusivo: false,
      explicacao:
        'Ainda não dá pra comparar: uma das versões tem menos de 12 conversas avaliadas. Deixe rodar mais um pouco.',
    };
  }

  const erroCombinado = Math.sqrt(
    (DESVIO_TIPICO * DESVIO_TIPICO) / a.n + (DESVIO_TIPICO * DESVIO_TIPICO) / b.n,
  );
  const limite = Z_95 * erroCombinado;

  if (diferenca <= limite) {
    return {
      vencedora: null,
      diferenca,
      conclusivo: false,
      explicacao: `As duas estão empatadas na prática (diferença de ${diferenca} ponto cabe dentro da variação normal). Mantenha a que já está no ar.`,
    };
  }

  return {
    vencedora: melhor.rotulo,
    diferenca,
    conclusivo: true,
    explicacao: `"${melhor.rotulo}" é realmente melhor que "${pior.rotulo}" — ${diferenca} ponto de diferença, acima da variação normal.`,
  };
}

function arredonda(v: number): number {
  return Math.round(v * 100) / 100;
}
