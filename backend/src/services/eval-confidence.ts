// ============================================================================
// eval-confidence.ts — a "trava por média" do motor de avaliação.
//
// O painel de Prompts já mostra a nota média por versão de prompt. Só que média
// sem tamanho de amostra engana: a nota que o juiz LLM dá a UMA conversa oscila
// tipicamente ±10-20% (viés de posição, de tamanho, não-determinismo). Comparar
// duas versões de prompt por poucas conversas é ler ruído.
//
// A margem de erro cai com a raiz de n: com poucas conversas ela é enorme, com
// dezenas fica pequena o bastante pra decidir. Este módulo transforma isso em
// uma resposta que o dono da clínica entende: "dá pra confiar?" e "qual versão
// é melhor DE VERDADE?" — em vez de deixá-lo comparar 7,9 com 7,2 sem saber que
// a diferença cabe dentro do ruído.
//
// Funções puras de propósito: dá pra testar sem banco e sem LLM.
// ============================================================================

/** Desvio-padrão típico da nota do juiz (0-10) numa mesma versão de prompt. */
const DESVIO_TIPICO = 1.5;
/** 1,96 desvios = intervalo de ~95%. */
const Z_95 = 1.96;

export type NivelConfianca = 'insuficiente' | 'indicativo' | 'confiavel';

export interface Confianca {
  n: number;
  nivel: NivelConfianca;
  /** Metade da largura do intervalo de 95% (em pontos da nota). */
  margemErro: number;
  /** Frase pronta pra tela, em português de dono de clínica. */
  explicacao: string;
}

/**
 * Quanta fé merece uma média feita sobre `n` conversas avaliadas.
 * Os cortes (12 / 40) saem da margem de erro: abaixo de 12 a margem passa de
 * ~0,85 ponto (qualquer comparação vira chute); a partir de 40 ela cai pra
 * ~0,46 e já separa versões que diferem de meio ponto pra cima.
 */
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

/**
 * Compara duas versões de prompt dizendo se a diferença é REAL ou ruído.
 * Usa o erro-padrão combinado das duas amostras — é o teste que impede o dono
 * de trocar um prompt bom por um pior baseado em três conversas de sorte.
 */
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

  // Erro-padrão da DIFERENÇA entre duas médias independentes.
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
