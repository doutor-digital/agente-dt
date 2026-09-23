import type { Unit } from '@prisma/client';
import { fmtBRL } from './prompt-composer.js';

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
 * texto pronto, antes de sair.
 *
 * O ERRO QUE NÃO PODE ACONTECER é o contrário: cobrar MAIS de quem tem direito
 * ao desconto. Esse é pior que o bug original — o paciente com plano ouvir
 * R$ 200 em vez de R$ 150 é a clínica mentindo o preço pra cima. Por isso a
 * trava é covarde de propósito e desiste em qualquer sinal de dúvida:
 *
 *  - a mensagem inteira cita plano/carteirinha/convênio em qualquer lugar? sai.
 *    Não basta olhar a frase: o modelo estabelece o contexto numa frase e dá o
 *    valor na seguinte ("Se você tiver plano, o valor muda. Pagando antes, fica
 *    R$ 150.") — julgando frase a frase isso virava aumento de preço.
 *  - a frase já traz o antecipado certo? sai. É comparação ou lista, não engano.
 *  - a frase fala de parcela ("2x de R$ 150")? sai. Ali o número é aritmética.
 *  - a unidade cobra taxa de reserva (Boa Vista)? sai. Lá o antecipado é PARTE
 *    do valor do dia, não alternativa — trocar número ali recria o engano que o
 *    prompt-composer já conserta.
 */

/** Marca de que o texto fala do convênio — aí o valor menor pode estar certo. */
const FALA_DE_CONVENIO =
  /carteirinh|conv[êe]nio|plano de sa[úu]de|seguro sa[úu]de|(?:seu|teu|do|no|com|pelo|tem|tiver|possui) plano\b|cart[ãa]o do plano|unimed|hapvida|bradesco|amil|sulam[ée]rica|ipasgo|notredame|golden cross|porto seguro|cassi|geap|s[ãa]o francisco sa[úu]de/i;

/** Marca de que a frase fala do pagamento antecipado. */
const FALA_DE_ANTECIPADO =
  /antecipad|adiantad|\bpix\b|pagar antes|pagando antes|pagamento antes|antes da consulta/i;

/** Parcela: ali o número é conta, não preço de consulta. */
const FALA_DE_PARCELA = /\d+\s*x\s*(?:de\s*)?R\$|parcel|dividir|divide|vezes de/i;

export interface PrecosDaUnidade {
  /** O valor do Pix antecipado, o que a frase errada deveria ter dito. */
  antecipado: number;
  /** O desconto de convênio, que só vale com carteirinha. */
  convenio: number;
}

/**
 * Quebra em frases SEM perder o que separa uma da outra.
 *
 * A primeira versão juntava as partes com join('') e comia todo espaço e quebra
 * de linha depois de ponto — a mensagem chegava ao paciente grudada, e o
 * chunker do Kommo, que corta em "\n\n" e ". ", cortava no meio da frase.
 * Por isso o separador anda junto com a frase.
 */
function frases(texto: string): string[] {
  return texto.split(/(?<=[.!?\n])/).filter((f) => f.length > 0);
}

const escapar = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reValor = (v: number) => new RegExp(`R\\$\\s*${escapar(fmtBRL(v))}(?:,00)?(?!\\d)`, 'gi');

export interface Correcao {
  texto: string;
  corrigiu: boolean;
}

export function corrigirPrecoDoConvenio(texto: string, precos: PrecosDaUnidade): Correcao {
  if (!texto || !Number.isFinite(precos.convenio) || !Number.isFinite(precos.antecipado)) {
    return { texto, corrigiu: false };
  }
  if (precos.convenio === precos.antecipado) return { texto, corrigiu: false };

  // Falou de plano em QUALQUER ponto da mensagem? Não encosto. O valor menor
  // provavelmente está certo, e errar aqui é cobrar mais caro de quem tem direito.
  if (FALA_DE_CONVENIO.test(texto)) return { texto, corrigiu: false };

  let corrigiu = false;
  const partes = frases(texto).map((frase) => {
    if (!reValor(precos.convenio).test(frase)) return frase;
    if (!FALA_DE_ANTECIPADO.test(frase)) return frase;
    // Já tem o antecipado certo na frase: é comparação ou lista, não engano.
    if (reValor(precos.antecipado).test(frase)) return frase;
    if (FALA_DE_PARCELA.test(frase)) return frase;
    corrigiu = true;
    return frase.replace(reValor(precos.convenio), `R$ ${fmtBRL(precos.antecipado)}`);
  });

  return { texto: corrigiu ? partes.join('') : texto, corrigiu };
}

/**
 * Lê o desconto do convênio na ficha da unidade.
 *
 * Não existe campo pra isso — como o preço da consulta, mora na prosa. O jeito
 * de achar é contar: desconto de carteirinha é UM valor só, repetido; tabela de
 * plano traz vários. Junto os valores que aparecem em frase de convênio e ficam
 * abaixo do antecipado — um só é desconto, mais de um é tabela e eu saio calado.
 *
 * Medido nas fichas reais: Bebedouro 150, Olímpia 150, Serra fora ({200, 250,
 * 220} — "Com plano: R$ 200" numa linha, "R$ 250 · R$ 220 antecipado" noutra).
 *
 * Tentei antes desconfiar da frase que junta convênio + "antecipado" + valor, e
 * não dá: a ficha de Bebedouro pareia as duas coisas DE PROPÓSITO, instruindo a
 * Sofia ("toda vez que citar o R$ 150, diga na mesma frase que é mediante
 * carteirinha; sem ela fica R$ 250, ou R$ 200 pagando antes no Pix"). Por isso
 * quem decide se a unidade entra é a lista do env, não o texto.
 */
export function precoDoConvenio(
  textos: Array<string | null | undefined>,
  precos: { antecipado: number },
): number | null {
  const valores = (f: string) => [...f.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/g)]
    .map((m) => Number(`${m[1].replace(/\./g, '')}.${m[2] ?? '0'}`));

  const candidatos = new Set(
    textos
      .filter(Boolean)
      .join('\n')
      .split(/(?<=[.!?\n])/)
      .filter((f) => FALA_DE_CONVENIO.test(f))
      .flatMap(valores)
      .filter((v) => v < precos.antecipado),
  );

  return candidatos.size === 1 ? [...candidatos][0] : null;
}

/**
 * Quais unidades entram na trava.
 *
 * Ler a ficha decide o VALOR bem, mas não serve pra decidir se a unidade entra:
 * qualquer edição de texto em qualquer clínica ligaria ou desligaria a trava
 * sozinha, sem ninguém olhar. Como o pior erro daqui é cobrar mais caro de quem
 * tem direito ao desconto, quem entra é declarado — no mesmo formato de lista
 * por slug que o resto do sistema já usa (FRANQUIA_MOVE_SLUGS e companhia).
 *
 * Unidade nova com desconto de carteirinha: confira a ficha e acrescente aqui.
 */
const SLUGS_COM_CONVENIO = new Set(
  (process.env.PRECO_CONVENIO_SLUGS ?? 'doutor-hernia-bebedouro,doutor-hernia-olimpia')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * O valor do convênio da unidade, calculado uma vez só.
 *
 * É fato imutável da ficha, e varrer o system prompt inteiro com regex a cada
 * mensagem (duas vezes por resposta, na verdade) não se paga.
 */
const cache = new Map<string, number | null>();

export function convenioDaUnidade(
  unit: Pick<Unit, 'id' | 'slug' | 'updatedAt' | 'sourceProdutos' | 'sourceNegocio' | 'sourcePapel' | 'systemPrompt' | 'spineBookingRequiresPayment'>,
  precos: { antecipado: number },
): number | null {
  if (!SLUGS_COM_CONVENIO.has(unit.slug)) return null;
  // Taxa de reserva (Boa Vista): o antecipado é parte do valor do dia, não alternativa.
  if (unit.spineBookingRequiresPayment) return null;

  const chave = `${unit.id}:${unit.updatedAt?.getTime() ?? 0}:${precos.antecipado}`;
  const guardado = cache.get(chave);
  if (guardado !== undefined) return guardado;

  const valor = precoDoConvenio(
    [unit.sourceProdutos, unit.sourceNegocio, unit.sourcePapel, unit.systemPrompt],
    precos,
  );
  if (cache.size > 200) cache.clear();
  cache.set(chave, valor);
  return valor;
}
