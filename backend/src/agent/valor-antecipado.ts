/**
 * O NÚMERO NO LUGAR DO ANTECIPADO TEM DE SER O ANTECIPADO DA UNIDADE.
 *
 * Pedido do gestor da Serra em 26/09/2026, pela segunda vez no mês: "favor corrigir a IA pq
 * continua enviando preços errados". A tabela certa da Serra é
 *
 *     particular: R$ 350 no dia · R$ 280 antecipado
 *     com plano:  R$ 250 no dia · R$ 220 antecipado
 *
 * e a IA anunciava "R$ 250 antecipado" para paciente particular — R$ 70 a menos, prometido
 * por escrito no WhatsApp.
 *
 * POR QUE O GUARDRAIL DE PREÇO NÃO PEGA: ele confere se o número EXISTE no catálogo da ficha,
 * não se é o número certo para aquele lugar da frase. E R$ 250 existe: é o valor de quem tem
 * plano pagando no dia. Então "R$ 250 antecipado" passa limpo — foi medido, passa mesmo.
 * Essa é a diferença entre um valor inventado (o guardrail resolve) e um valor real usado no
 * slot errado (só isto resolve).
 *
 * O MESMO ERRO EM OUTRAS UNIDADES: a Boa Vista já anunciou "R$ 450 ou R$ 100" porque 450 saiu
 * de uma NEGAÇÃO na ficha, e a Serra já trocou 280 por 250 antes. O padrão é sempre o mesmo —
 * a ficha tem vários números, o modelo escolhe o errado para o slot do antecipado.
 *
 * ── O QUE NÃO ENTRA, e é o cuidado que importa ────────────────────────────────────────────
 * 1. MENSAGEM QUE FALA DE PLANO/CONVÊNIO SAI INTEIRA. Lição que já custou caro em
 *    `preco-convenio.ts`: corrigir frase por frase fez a IA AUMENTAR o preço de quem tem
 *    plano. Se o plano aparece em qualquer lugar da mensagem, esta trava não toca em nada —
 *    ali o dono é o fluxo de convênio.
 * 2. UNIDADE COM TAXA DE RESERVA SAI INTEIRA (`spineBookingRequiresPayment`, Boa Vista). Lá o
 *    antecipado é PARTE do valor do dia, não alternativa: "R$ 100 antecipado + R$ 250 no dia"
 *    está certo e trocar o 100 por 350 seria o desastre.
 * 3. O PREÇO DO DIA NÃO É O SLOT DO ANTECIPADO (19/11/2026). A janela "R$ X … marca" tem até 45 caracteres e achava o preço do dia quando
 *    a frase o CONTRAPÕE ao antecipado — "R$ 350 no dia, mas se pagar antes, no Pix, fica R$ 200" virava "R$ 200 no dia, mas… fica R$ 200"
 *    (Açailândia, Balsas, Canaã, Mossoró: 9 vezes em 30 dias). A decisão é por NÚMERO, não por palavra (3 rodadas de lista de palavras erraram):
 *    a unidade sabe quanto custa o dia (`noDia`, de `precosDaConsulta`) e quanto custa o antecipado. Com a marca há dois lugares de R$: X (antes) e Y (o que
 *    a marca traz logo depois dela, numa gramática fechada: "pagando antes [por Pix], fica [em] R$ Y" / "antecipado de R$ Y" / "antecipado: R$ Y").
 *    X é o preço do DIA da unidade quando é igual ao `noDia`. Se existe Y, X NÃO é o slot (é a outra opção) e Y é conferido (vira o antecipado). A frase
 *    dizer "no dia" (não "no dia 21") sozinha não basta; junto de um Y que já é o antecipado certo, X é pulado (nada a conferir em Y). Sem Y, X só é pulado
 *    se for o `noDia` E a frase disser "no dia". Em todo outro caso nada muda: a frase segue como no main. Y nunca é conferido se for o `noDia`, o sinal
 *    ("agora", "de sinal") ou vier seguido de "no dia".
 */

/** Marcadores de que o R$ anterior é o valor do pagamento antecipado. */
const MARCA_ANTECIPADO =
  '(?:antecipad[ao]|pagando\\s+antes|pagar\\s+antes|paga\\s+antes|antes\\s+por\\s+(?:pix|p[ií]x)|por\\s+pix\\s+antes|com\\s+anteced[êe]ncia)';

/**
 * O R$ que a PRÓPRIA marca traz, logo depois dela, numa gramática FECHADA (nada de palavra solta no meio, então "pagando antes de vir, e no dia fica R$ 350",
 * "só pagando antes, do contrário sai R$ 350" e "o restante fica R$ 200" não casam):
 *   marca [, por/via/no Pix] [,] (fica|sai|custa|passa|é|são) [em|por|de|só|apenas|a] R$ Y     "pagando antes por PIX, fica em R$ 250"
 *   marca (de|:) R$ Y                                                                           "o Pix antecipado de R$ 200", "antecipado: R$ 250"
 * Grupo 1 = o que vem antes do "R$"; grupo 2 = o "R$ 250"; grupo 3 = o número.
 */
const MEIO_DE_PAGAR = String.raw`(?:\s+(?:por|via|pelo|no|com|em)\s+(?:o\s+)?(?:pix|p[ií]x|link|cart[aã]o|transfer[eê]ncia))?`;
const VALOR = String.raw`(R\$\s?(\d{2,4}(?:[.,]\d{2})?))`;
const VALOR_DA_MARCA = new RegExp(
  String.raw`^((?:\s*,)?${MEIO_DE_PAGAR}\s*,?\s*(?:(?<![\p{L}\d])(?:fica(?:m)?|sai(?:m)?|custa|passa|é|são)\s+(?:(?:em|por|de|só|apenas|a)\s+)*|(?:de|:)\s*))${VALOR}`,
  'iu',
);
/** Esse R$ não é o antecipado: vem seguido de "no dia" (não "no dia 21") / "na clínica" (preço do dia) ou de "agora / de sinal / de entrada / de reserva" (o sinal). */
const NAO_E_O_ANTECIPADO_DEPOIS = /^\s*(?:no\s+dia\b(?!\s+\d)|na\s+cl[ií]nica\b|agora\b|(?:de\s+)?(?:sinal|entrada|reserva)\b)/i;
/** "no dia" como jeito de pagar, não data ("no dia 21"). */
const NO_DIA = /\bno\s+dia\b(?!\s+\d)/i;

const MARCA_NO_FIM = new RegExp(`${MARCA_ANTECIPADO}$`, 'i');

/** Se isto aparece na mensagem, o assunto é plano de saúde e a trava não opina. */
const FALA_DE_PLANO = /\b(plano\s+de\s+sa[úu]de|conv[êe]nio|carteirinha|unimed|amil|bradesco\s+sa[úu]de|hapvida|ipasgo|cassi|geap)\b/i;

export interface OpcoesAntecipado {
  /** O valor antecipado oficial da unidade, de `precosDaConsulta`. */
  antecipado: number;
  /** Unidade com taxa de reserva obrigatória — a trava não vale lá. */
  taxaDeReserva?: boolean;
  /**
   * Valores que são legítimos ao lado de "antecipado" e NÃO podem ser trocados pelo antecipado: o sinal de R$ 50 e o resto de R$ 200 da
   * unidade com sinal por Pix (Sofia 2.0). "Sinal antecipado de R$ 50" não é o R$ 250 errado no slot do antecipado.
   */
  valoresLegitimos?: readonly number[];
  /** O preço do dia da unidade (`precosDaConsulta().noDia`): o R$ igual a ele é o "outro" preço da frase, não o slot do antecipado. Sem ele, nada é pulado por esse motivo. */
  noDia?: number;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));
const paraNumero = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));

export function corrigirValorAntecipado(
  texto: string,
  { antecipado, taxaDeReserva = false, valoresLegitimos = [], noDia }: OpcoesAntecipado,
): { texto: string; corrigiu: number[] } {
  if (!texto || !Number.isFinite(antecipado) || antecipado <= 0) return { texto, corrigiu: [] };
  if (taxaDeReserva) return { texto, corrigiu: [] };
  // Bail de mensagem inteira, não de frase. Ver nota 1 no topo.
  if (FALA_DE_PLANO.test(texto)) return { texto, corrigiu: [] };

  // R$ X ... <marca de antecipado>, sem outro R$ no meio — senão "R$ 350 no dia, ou R$ 250
  // antecipado" casaria com o 350.
  const re = new RegExp(
    `R\\$\\s?(\\d{2,4}(?:[.,]\\d{2})?)((?:(?!R\\$)[^\\n.;)]){0,45}?${MARCA_ANTECIPADO})`,
    'gi',
  );

  const corrigiu: number[] = [];
  const edicoes: { ini: number; fim: number; novo: string }[] = [];
  const tratados = new Set<number>();

  /** Troca o R$ em [ini, fim) pelo antecipado, se for um valor a corrigir. */
  const trocar = (v: number, ini: number, fim: number): void => {
    if (!Number.isFinite(v) || v === antecipado || valoresLegitimos.includes(v)) return;
    // Parcelamento não é o valor da consulta: "3x de R$ 100" não vira "3x de R$ 280".
    // O "3x de" está ANTES do valor, então tem de vir do texto original pela posição.
    if (/\d\s*x\s*(?:de\s*)?$/i.test(texto.slice(Math.max(0, ini - 14), ini))) return;
    corrigiu.push(v);
    edicoes.push({ ini, fim, novo: `R$ ${fmt(antecipado)}` });
  };

  for (const m of texto.matchAll(re)) {
    const todo = m[0];
    const valor = m[1]!;
    const meio = m[2]!;
    const posicao = m.index ?? 0;
    if (tratados.has(posicao)) continue;
    const marca = MARCA_NO_FIM.exec(meio);
    const entre = marca ? meio.slice(0, marca.index) : meio;
    // X é o preço do DIA da unidade quando é o número que ela cobra no dia (`noDia`). A palavra "no dia" (não "no dia 21") sozinha NÃO basta: só junto de um Y já certo.
    const xEhNoDia = noDia != null && paraNumero(valor) === noDia;
    const xDizNoDia = NO_DIA.test(entre);
    if (xEhNoDia || xDizNoDia) {
      // Y: o R$ que a marca traz depois dela (nota 3 no topo). Não é o antecipado se for o preço do dia, o sinal ou vier seguido de "no dia".
      const depois = texto.slice(posicao + todo.length);
      const d = VALOR_DA_MARCA.exec(depois);
      const yIni = d ? posicao + todo.length + d[1]!.length : -1;
      const yFim = d ? yIni + d[2]!.length : -1;
      const yV = d ? paraNumero(d[3]!) : NaN;
      const temY = !!d && yV !== noDia && !NAO_E_O_ANTECIPADO_DEPOIS.test(texto.slice(yFim));
      // X é o preço do dia e há Y: o antecipado é o Y, que passa a ser conferido. X diz "no dia" e Y já é o antecipado certo: X é o preço do dia, nada a conferir em Y.
      // X é o preço do dia e diz "no dia", sem Y: nada a trocar. Em todo outro caso a frase segue como no main.
      if ((temY && (xEhNoDia || (xDizNoDia && yV === antecipado))) || (xEhNoDia && xDizNoDia)) {
        if (temY && xEhNoDia) {
          tratados.add(yIni);
          trocar(yV, yIni, yFim);
        }
        continue;
      }
    }
    trocar(paraNumero(valor), posicao, posicao + todo.length - meio.length);
  }

  let saida = texto;
  for (const e of edicoes.sort((a, b) => b.ini - a.ini)) saida = saida.slice(0, e.ini) + e.novo + saida.slice(e.fim);
  return { texto: saida, corrigiu };
}

/**
 * "SINAL DE R$ 250 ANTECIPADO": o valor depois de "sinal de" é o SINAL da unidade, e só ele.
 *
 * Unidade que vende sinal (Balsas, Canaã, Araguaína, Imperatriz, Marabá, Açailândia, Porto…): o modelo escreve "R$ 250 garantindo com
 * sinal de R$ 250 antecipado". O "sinal de R$ 250" é errado (o sinal é R$ 50) e trocá-lo pelo antecipado também seria — era o que
 * acontecia em Balsas ("sinal de R$ 200 antecipado", 3 vezes em 30 dias) e o que NÃO acontecia nas outras unidades, onde R$ 250 é o
 * antecipado e a frase saía como o modelo escreveu (22 vezes em 30 dias em Araguaína, Imperatriz e Marabá, já enviadas ao paciente).
 *
 * Só vale o que está escrito como "sinal de R$ X" / "sinal no valor de R$ X" / "sinal de entrada de R$ X" SEGUIDO de "antecipado" (o slot do
 * antecipado; "O sinal de R$ 100 garante a vaga" continua pelo corte de catálogo), com o R$ visível. "O sinal é R$ X",
 * "sinal antecipado é R$ X" e "Com sinal: R$ X" ficam de fora de propósito: é como a Sofia escreve o TOTAL com sinal ("o valor com o sinal antecipado é R$ 250 (R$ 50 + R$ 200)"),
 * e esse número é conferido pelo caminho do total, não trocado pelo sinal. Fora de frase,
 * em que o PACIENTE pagou/mandou/transferiu ("Você enviou o sinal de R$ 30, faltam R$ 20" relata o que ele fez). O R$ que o texto
 * diz claramente ser do paciente chega aqui escondido pelo guardrail (`R$ ⟦n⟧`).
 */
const ANTES_DO_SINAL = /\bsinal\s*(?:(?:de\s+entrada|do\s+pix|da\s+reserva)\s+)?(?:de\s+|no\s+valor\s+de\s+)$/i;
/** O paciente é quem pagou/mandou: "Você enviou o sinal de R$ 30" relata o que ELE fez, não é o sinal da unidade. */
const RELATA_O_QUE_O_PACIENTE_FEZ = /\b(?:pagou|enviou|mandou|transferiu|depositou|recebi|recebemos|comprovante|caiu|chegou|veio)\b/i;
const VALOR_DO_SINAL = /R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;
/** O "antecipado" que a frase cola ao sinal logo depois do valor: "sinal de R$ 250 antecipado", "sinal de R$ 250 no Pix antecipado". */
const ANTECIPADO_LOGO_DEPOIS = new RegExp(`^(?:(?!R\\$)[^\\n.;)]){0,15}?${MARCA_ANTECIPADO}`, 'i');

export function corrigirSinalErrado(
  texto: string,
  { sinal, taxaDeReserva = false }: { sinal: number; taxaDeReserva?: boolean },
): { texto: string; corrigiu: number[] } {
  if (!texto || !Number.isFinite(sinal) || sinal <= 0 || taxaDeReserva) return { texto, corrigiu: [] };
  if (FALA_DE_PLANO.test(texto)) return { texto, corrigiu: [] };
  const corrigiu: number[] = [];
  const saida = texto.replace(VALOR_DO_SINAL, (todo, _inteiro: string, posicao: number) => {
    if (!ANTES_DO_SINAL.test(texto.slice(Math.max(0, posicao - 36), posicao))) return todo;
    // Só "sinal de R$ X ANTECIPADO": o slot que o guardrail já olha. "O sinal de R$ 100 garante a vaga" segue pelo corte de catálogo, como sempre foi.
    if (!ANTECIPADO_LOGO_DEPOIS.test(texto.slice(posicao + todo.length))) return todo;
    // Frase em que o paciente pagou/mandou: o R$ é dele (o guardrail só esconde o que o texto diz CLARAMENTE ser do paciente; na dúvida, não inventa).
    const frase = texto.slice(0, posicao).split(/[.!?](?=\s)|\n/).pop() ?? '';
    if (RELATA_O_QUE_O_PACIENTE_FEZ.test(frase)) return todo;
    const v = paraNumero(todo.replace(/^R\$\s?/i, ''));
    if (!Number.isFinite(v) || v === sinal) return todo;
    corrigiu.push(v);
    return `R$ ${fmt(sinal)}`;
  });
  return { texto: saida, corrigiu };
}
