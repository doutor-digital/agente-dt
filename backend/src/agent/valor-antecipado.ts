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
 *    a frase o CONTRAPÕE ao antecipado: "R$ 350 no dia, mas se pagar antes, no Pix, fica R$ 200" virava "R$ 200 no dia, mas… fica R$ 200"
 *    (Açailândia, Balsas, Canaã, Mossoró: 9 vezes em 30 dias). A decisão é por NÚMERO, não por palavra (3 rodadas de lista de palavras erraram):
 *    a unidade sabe quanto cobra no dia (`noDia`, de `precosDaConsulta`), quanto cobra antecipado e quanto é o sinal (`sinal`).
 *
 *    Com a marca há dois lugares de R$: X (antes dela) e Y (o que a marca traz logo depois, numa gramática fechada: "pagando antes [por Pix], fica [em] R$ Y",
 *    "antecipado de R$ Y", "antecipado: R$ Y"). A ordem das regras, da mais forte para a mais fraca:
 *      a. X COLADO na marca (só o modo de pagar entre os dois: "R$ 350 pagando antecipado, fica R$ 250") É o antecipado: conferido como sempre, nunca pulado;
 *      b. Y não conta se for o `noDia`, o `sinal`, "agora", "de sinal / entrada / reserva", "mais barato" ou vier seguido de "no dia / na clínica";
 *      c. X igual ao `noDia` e existe Y: X é a outra opção e Y é conferido (vira o antecipado);
 *      d. a frase diz "no dia" (não "no dia 21") entre X e a marca e existe Y: X é pulado (se estiver errado, o catálogo corta; nunca vira o antecipado), Y não é mexido;
 *      e. X igual ao `noDia` e a frase diz "no dia", sem Y: nada a trocar.
 *    Em todo outro caso nada muda: a frase segue como no main.
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
const NAO_E_O_ANTECIPADO_DEPOIS = /^\s*(?:no\s+dia\b(?!\s+\d)|na\s+cl[ií]nica\b|agora\b|mais\s+(?:barato|em\s+conta)\b|de\s+(?:desconto|economia)\b|(?:de\s+)?(?:sinal|entrada|reserva)\b)/i;
/** O que pode vir entre o R$ e a marca sem deixar de ser "R$ colado na marca": só o modo de pagar ("R$ 350 pagando antecipado", "R$ 350 com pagamento antecipado", "R$ 350 pelo Pix antecipado"). */
const MODO_DE_PAGAR_ANTES = /\b(?:pagando|pagar|paga|pagamento|com|no|pelo|por|via|pix|p[ií]x|link)\b/gi;
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
  /** O sinal da unidade (R$ 50): um R$ igual a ele depois da marca ("antecipado de R$ 50", "fica R$ 50 + R$ 200") é o sinal, não o antecipado. */
  sinal?: number;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));
const paraNumero = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));

export function corrigirValorAntecipado(
  texto: string,
  { antecipado, taxaDeReserva = false, valoresLegitimos = [], noDia, sinal }: OpcoesAntecipado,
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
    // X COLADO na marca (só o modo de pagar entre os dois: "R$ 350 pagando antecipado, fica R$ 250") É o antecipado e é conferido: não é a "outra opção".
    const xColado = !/[,;:()—–-]/.test(entre) && !/[\p{L}\d]/u.test(entre.replace(MODO_DE_PAGAR_ANTES, ''));
    if (!xColado && (xEhNoDia || xDizNoDia)) {
      // Y: o R$ que a marca traz depois dela (nota 3 no topo). Não é o antecipado se for o preço do dia, o sinal ou vier seguido de "no dia".
      const depois = texto.slice(posicao + todo.length);
      const d = VALOR_DA_MARCA.exec(depois);
      const yIni = d ? posicao + todo.length + d[1]!.length : -1;
      const yFim = d ? yIni + d[2]!.length : -1;
      const yV = d ? paraNumero(d[3]!) : NaN;
      const temY = !!d && yV !== noDia && yV !== sinal && !NAO_E_O_ANTECIPADO_DEPOIS.test(texto.slice(yFim));
      // X é o preço do dia (é o noDia, ou a frase diz "no dia") e há Y: X é a outra opção, nunca vira o antecipado (se estiver errado, quem corta é o catálogo).
      // Y é conferido só quando X é o noDia da unidade. X é o noDia e diz "no dia", sem Y: nada a trocar. Em todo outro caso a frase segue como no main.
      if (temY || (xEhNoDia && xDizNoDia)) {
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

/** O texto (já cortado antes do valor) cita `v` como R$? */
const valorAntes = (antes: string, v: number): boolean =>
  [...antes.matchAll(VALOR_DO_SINAL)].some((m) => paraNumero(m[0].replace(/^R\$\s?/i, '')) === v);

export function corrigirSinalErrado(
  texto: string,
  { sinal, taxaDeReserva = false, antecipado }: { sinal: number; taxaDeReserva?: boolean; antecipado?: number },
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
    // "O valor com sinal de R$ 250 antecipado (R$ 50 agora + R$ 200 no dia)": o R$ é o antecipado da unidade, é a PRIMEIRA vez que a mensagem o diz e o desdobramento
    // com o sinal vem logo depois — é o total com sinal mal rotulado, não o sinal repetido. O erro de verdade repete o total ("R$ 250 garantindo com sinal de R$ 250
    // antecipado") ou não traz desdobramento ("é só pagar o sinal de R$ 200 antecipado"): esses viram o sinal.
    if (antecipado != null && v === antecipado && !valorAntes(texto.slice(0, posicao), antecipado) && valorAntes(texto.slice(posicao + todo.length, posicao + todo.length + 80), sinal)) return todo;
    corrigiu.push(v);
    return `R$ ${fmt(sinal)}`;
  });
  return { texto: saida, corrigiu };
}
