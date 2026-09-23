/**
 * O desconto do convênio não pode virar o preço do Pix.
 *
 * Bebedouro tem três valores: R$ 250 na clínica, R$ 200 antecipado por Pix, e
 * R$ 150 SÓ para quem apresenta a carteirinha do plano. O prompt diz isso com
 * todas as letras — "Pix antecipado NUNCA é R$ 150", "quem não tem plano NUNCA
 * ouve R$ 150" — e mesmo assim, em 23/09/2026, a Sofia escreveu duas vezes ao
 * mesmo paciente:
 *
 *   "A consulta é R$ 250 na clínica no dia, ou R$ 150 se pagar antes pela chave Pix"
 *   "o valor antecipado é R$ 150"
 *
 * Três preços na mesma cabeça dão nisso. Instrução mais forte não resolve — o
 * modelo já tinha a instrução mais forte possível. Então a trava é aqui, no
 * texto pronto, antes de sair: se o desconto do convênio aparecer colado em
 * "antecipado" ou "Pix" SEM a carteirinha na mesma frase, o número está errado
 * e vira o antecipado de verdade.
 *
 * Erra pro lado seguro: na dúvida (frase que cita carteirinha/plano) não mexe,
 * porque ali o valor menor está certo.
 */

export interface PrecosDaUnidade {
  /** O valor do Pix antecipado, o que a frase errada deveria ter dito. */
  antecipado: number;
  /** O desconto de convênio, que só vale com carteirinha. */
  convenio: number;
}

/** Marca de que a frase fala do convênio — aí o valor menor é legítimo. */
const FALA_DE_CONVENIO = /carteirinh|conv[êe]nio|plano de sa[úu]de|unimed|hapvida|bradesco sa[úu]de|amil|sulam[ée]rica/i;

/** Marca de que a frase fala do pagamento antecipado. */
const FALA_DE_ANTECIPADO = /antecipad|adiantad|pix|pagar antes|pagando antes|pagamento antes|antes da consulta/i;

/**
 * Quebra o texto em frases para julgar cada uma sozinha.
 *
 * Julgar a mensagem inteira daria falso positivo: é comum e correto ela dizer os
 * três valores numa mesma mensagem, em frases separadas — o erro é os dois
 * conceitos na MESMA frase.
 */
function frases(texto: string): string[] {
  return texto.split(/(?<=[.!?\n])\s*/).filter((f) => f.trim().length > 0);
}

const reValor = (v: number) => new RegExp(`R\\$\\s*${v}(?:,00)?\\b`, 'gi');

export interface Correcao {
  texto: string;
  corrigiu: boolean;
}

export function corrigirPrecoDoConvenio(texto: string, precos: PrecosDaUnidade): Correcao {
  if (!texto || !Number.isFinite(precos.convenio) || !Number.isFinite(precos.antecipado)) {
    return { texto, corrigiu: false };
  }
  if (precos.convenio === precos.antecipado) return { texto, corrigiu: false };

  let corrigiu = false;
  const partes = frases(texto).map((frase) => {
    if (!reValor(precos.convenio).test(frase)) return frase;
    // A frase fala de carteirinha/plano? Então o valor menor está certo ali.
    if (FALA_DE_CONVENIO.test(frase)) return frase;
    if (!FALA_DE_ANTECIPADO.test(frase)) return frase;
    corrigiu = true;
    return frase.replace(reValor(precos.convenio), `R$ ${precos.antecipado}`);
  });

  return { texto: corrigiu ? partes.join('') : texto, corrigiu };
}

/**
 * Lê o desconto do convênio no texto da unidade.
 *
 * Não existe campo pra isso — como o preço da consulta, mora na prosa da ficha.
 * Procuro o R$ mais próximo de uma palavra de convênio, na mesma frase, e exijo
 * que seja MENOR que o antecipado: se for igual ou maior, não é desconto e eu
 * prefiro não ter valor a ter o errado.
 *
 * DESISTO da unidade que tem uma TABELA de plano, não um desconto. A Serra diz
 * "Com PLANO DE SAÚDE: R$ 250 · R$ 220 com pagamento antecipado" — lá o plano
 * tem o próprio antecipado, e uma frase solta com o valor do plano é legítima
 * mesmo falando de Pix. Corrigir ali SUBIRIA o preço de quem tem plano, que é
 * pior que o erro original.
 *
 * O sinal é contar: um desconto de carteirinha é UM valor só, repetido. Uma
 * tabela de plano traz vários. Junto todos os valores que aparecem em frase de
 * convênio e ficam abaixo do antecipado; se sobrar exatamente um, é o desconto
 * e a trava vale. Se sobrar mais de um, a unidade tem tabela e eu saio calado.
 *
 * Bebedouro e Olímpia sobram {150}. A Serra sobra {200, 250, 220} — "Com plano
 * de saúde: R$ 200" numa linha, "Com PLANO DE SAÚDE: R$ 250 · R$ 220 com
 * pagamento antecipado" noutra. Contar é mais firme que procurar palavra: a
 * ficha de Bebedouro tem frases que citam carteirinha e Pix juntos ("sem a
 * carteirinha fica R$ 250, ou R$ 200 pagando antes no Pix"), que são recado pra
 * Sofia e não segunda tabela — qualquer heurística de palavra tropeçava nelas.
 */
export function precoDoConvenio(
  textos: Array<string | null | undefined>,
  precos: { antecipado: number; noDia: number },
): number | null {
  const valores = (f: string) => [...f.matchAll(/R\$\s*(\d{2,4})/g)].map((m) => Number(m[1]));

  const candidatos = new Set(
    textos
      .filter(Boolean)
      .join('\n')
      .split(/(?<=[.!?\n])\s*/)
      .filter((f) => FALA_DE_CONVENIO.test(f))
      .flatMap(valores)
      .filter((v) => Number.isFinite(v) && v < precos.antecipado && v !== precos.noDia),
  );

  return candidatos.size === 1 ? [...candidatos][0] : null;
}
