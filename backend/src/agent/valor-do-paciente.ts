/**
 * O R$ QUE O PACIENTE PAGOU OU MANDOU É DADO DELE, NÃO PREÇO DA UNIDADE.
 *
 * Quando o paciente manda um comprovante, a Sofia comenta o valor que veio: "O comprovante mostra R$ 50,00, mas o valor antecipado
 * da nossa consulta é R$ 200,00". As travas de preço (`valor-antecipado.ts`, o corte de catálogo do `guardrail.ts`) olham todo "R$ X"
 * perto da palavra "antecipado" e perguntam "esse é o preço da unidade?". O R$ 50,00 do comprovante não é — e era trocado pelo preço:
 *
 *   "O comprovante mostra R$ 200, mas o valor do pagamento antecipado é R$ 200 — então não bate"
 *   "o valor mostrado foi de R$ 250 — e o valor antecipado é de R$ 250"
 *   "Esse comprovante de R$ 350 parece ser de outro paciente"   (o comprovante era de R$ 1.500)
 *
 * Pelo menos 11 vezes em 30 dias (Canaã 6, parauapebas-resgate 3, Marabá 1, Rio Verde 1), todas em `execution_steps` "Guardrail
 * reescreveu" (`antecipado_corrigido` / `preco_corrigido`): uma frase que a IA escreveu certa virou um absurdo que NINGUÉM escreveu.
 *
 * Esta função só diz ONDE (posição do "R$") há valor do paciente; quem esconde das travas é o guardrail, do mesmo jeito que já
 * esconde o valor da oferta da campanha. O preço da unidade na MESMA mensagem segue conferido, porque a decisão é por valor, não por frase.
 *
 * ── O QUE CONTA COMO "DO PACIENTE" — e o cuidado é não esconder preço da unidade ─────────────────────────────────────────────
 * Esconder valor da trava é abrir mão de conferi-lo; então só entra o que o texto diz CLARAMENTE ser do paciente, com um verbo de relato
 * colado ao valor — a palavra "comprovante" sozinha não basta ("Falta só o comprovante do Pix de R$ 250" é o preço, um pedido):
 *   ANTES do valor (mesma frase, sem outro R$ no meio):  "comprovante é de / mostra / mostrou / foi R$", "o valor do comprovante (R$",
 *       "comprovante …, mas o valor de R$", "você pagou/enviou/mandou/transferiu … R$", "o valor que veio/caiu/mostrado … R$", "o valor/pagamento foi de R$"
 *   DEPOIS do valor:  "R$ 50 não bate", "R$ 50 que você pagou", "R$ 50 que recebi/caiu"; com "comprovante" antes na frase, também
 *       "R$ 200 ficou abaixo / é menor / é diferente"
 * NÃO entra: pedido ("me enviar o comprovante certinho, com o valor de R$ 200" — aí o R$ 200 É o preço), nem trecho que já fala do preço
 * da unidade (antecipado, sinal, garantir, consulta) entre o verbo e o valor. Na dúvida, não esconde (= o comportamento de antes).
 */

const VALOR = /R\$\s*(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;

/** Fim de frase: ponto/!/? seguido de espaço, ou quebra de linha. O ponto de "R$ 1.500" não conta (vem colado ao dígito). */
const FIM_DE_FRASE_G = /[.!?](?=\s)|\n/g;
const FIM_DE_FRASE = /[.!?](?=\s)|\n/;

/** Atalho: texto sem NENHUM destes sinais não tem valor do paciente (e a saída de toda resposta passa por aqui). */
const ALGUM_SINAL_DO_PACIENTE =
  /comprovante|pagou|enviou|mandou|transferiu|depositou|recebi|caiu|veio|chegou|apareceu|mostrad|consta|aparece|identificad|\bleu\b|n[aã]o\s+(?:bate|confere|corresponde|fecha)|\b(?:valor|pagamento|pix|dep[oó]sito|transfer[eê]ncia)\s+foi\b/i;

/** Verbos que o paciente fez com o dinheiro. */
const FEZ = '(?:pagou|enviou|mandou|transferiu|depositou)';
/** Verbos com que a Sofia relata o que o comprovante traz. */
const RELATA = '(?:é|foi|era|mostra|mostrou|aponta|apontou|indica|indicou|consta|diz|tem|veio)';

/** Trecho, antes do valor, que relata o que o paciente mandou. Termina no valor (`$`). */
const ANTES_DO_PACIENTE: RegExp[] = [
  // "o comprovante é de", "o comprovante mostra", "o valor do comprovante é", "o comprovante que recebi mostra" — verbo de relato colado ao valor
  // (o trecho entre "comprovante" e o verbo não pode falar de valor/preço/Pix: "Com o comprovante o valor é R$ 300" é o preço)
  new RegExp(String.raw`comprovante\b(?:(?!\bvalor\b|\bpre[çc]o\b|\bpix\b)[^,;:—–-]){0,18}?(?<=\s)${RELATA}\s+(?:de\s+)?$`, 'i'),
  // "Esse comprovante de R$ 1.500", "o valor do comprovante (R$ 200)"
  /comprovante\s+de\s+$/i,
  /comprovante\s*\(\s*$/i,
  // "O comprovante é da nossa clínica, mas o valor de R$ 50 não bate" / "…, mas o valor de R$ 200 ficou abaixo"
  /comprovante\b[^]{0,60}?\bmas\b[^,;—–-]{0,20}?\bvalor\s+(?:de\s+)?$/i,
  // "você pagou", "você já enviou o Pix de"
  // (sem vírgula/dois-pontos/travessão e sem valor/preço/fica/é no meio: "Você enviou tudo, o valor fica R$ 250" é o preço; "o Pix de R$" passa)
  new RegExp(String.raw`\b(?:voc[eê]|vc)\s+(?:j[aá]\s+)?${FEZ}\b(?:(?!\bvalor\b|\bpre[çc]o\b|\bfica\w*|\bé\b|\bs[aã]o\b)[^,;:—–-]){0,25}$`, 'i'),
  // "o valor que veio/caiu/chegou/consta/aparece/mostrado …", "o valor mostrado foi de"
  // (só o verbo e, no máximo, "foi/é/era [de]": "o valor mostrado no site é R$ 250" não relata o que o paciente mandou)
  /\bvalor\s+(?:que\s+)?(?:veio|caiu|chegou|consta|aparece|mostrad[oa]|identificad[oa]|leu)\s+(?:(?:foi|é|era)\s+)?(?:de\s+)?$/i,
  // "o valor foi de", "o pagamento foi", "o Pix foi de" — passado: o preço da unidade se diz no presente ("é")
  /\b(?:valor|pagamento|pix|dep[oó]sito|transfer[eê]ncia)\s+foi\s+(?:de\s+)?$/i,
];

/** Trecho, depois do valor, que o mostra como coisa do paciente. Começa logo depois do valor. */
const DEPOIS_DO_PACIENTE: RegExp[] = [
  new RegExp(String.raw`^\s*,?\s*(?:que\s+)?(?:voc[eê]|vc)\s+(?:j[aá]\s+)?${FEZ}\b`, 'i'), // "R$ 50 que você pagou"
  /^\s*,?\s*(?:que\s+)?(?:recebi|caiu|chegou|veio|apareceu)\b/i, // "R$ 50 que recebi"
  /^\s*(?:ainda\s+)?n[aã]o\s+(?:bate|confere|corresponde|fecha)\b/i, // "R$ 50 não bate", "R$ 50 ainda não bate" (e NÃO "R$ 200 — então não bate": ali é o preço)
];
/** Só vale com "comprovante" antes, na mesma frase: o comprovante é o assunto, e o valor dele ficou abaixo/acima do esperado. */
const DEPOIS_COM_COMPROVANTE = /^\s*(?:ainda\s+)?(?:ficou|est[aá]|é)\s+(?:bem\s+|um\s+pouco\s+)?(?:abaixo|acima|menor|maior|diferente|inferior|superior)\b/i;

/** O trecho entre o verbo e o valor já fala do preço da unidade ou PEDE alguma coisa: então o valor não é o que o paciente mandou. */
const FALA_DO_PRECO_OU_PEDE =
  /\b(?:antecipad\w*|sinal|garant\w*|consulta|reserva\w*|pagando\s+antes|pagar\s+antes|precis\w+|deve\w*|tem\s+que|tem\s+de|necess\w+|valor\s+(?:certo|correto)|seja|ser[áa]?)\b/i;

/** Pedido de comprovante ("me enviar", "manda o comprovante"): infinitivo ou imperativo, não o passado ("enviou", "mandou"). */
const PEDE_ENVIO = /\b(?:enviar|envie|envia|mandar|mande|manda|reenviar|reenvie|reenvia|anexar|anexe|anexa)\b/i;

/**
 * O que vem COLADO depois do valor diz que ele é preço ("R$ 250 antecipado", "R$ 300 no dia", "R$ 300 a consulta antecipada"): então não é o que o
 * paciente mandou, é o que a Sofia está dizendo que custa — e segue conferido. Até duas palavras no meio; vírgula, travessão ou ponto cortam
 * ("R$ 50,00, mas o valor antecipado…" continua sendo o valor do comprovante).
 */
const PRECO_COLADO_DEPOIS = new RegExp(
  String.raw`^\s*(?:` +
    // "R$ 250 antecipado", "R$ 300 a consulta antecipada", "R$ 300 no dia", "R$ 300 no Pix antecipado"
    String.raw`(?:(?:a|o|de|da|do|no|na|pelo|via|por|pra|para)\s+)?(?:(?:consulta|pix)\s+)?(?:antecipad\w*|no\s+dia|na\s+cl[ií]nica|na\s+hora|[àa]\s+vista|no\s+ato|sinal)` +
    // "R$ 300 a consulta", "R$ 300 pra consulta presencial"
    String.raw`|(?:(?:pra|para|por)\s+)?(?:a\s+|essa\s+)?consulta\b` +
    // "o valor de R$ 250 é o antecipado", "R$ 250 é o valor da consulta"
    String.raw`|(?:é|são)\s+(?:o|a)\s+(?:valor\s+)?(?:antecipad\w*|d[ao]\s+(?:consulta|sinal|dia))` +
    `)`,
  'iu',
);

/** Condicional ("se você já pagou os R$ 250", "caso tenha mandado") e espera ("fico no aguardo do comprovante de R$ 250"): não relata nada, o R$ é preço ou pedido. */
const CONDICIONAL_OU_ESPERA =
  /\b(?:se|caso|quando|assim\s+que|depois\s+que|sempre\s+que|aguard\w+|esper\w+|falta\w*|preciso|precisamos|pendente)\b/i;

function trechoDaFraseAntes(texto: string, ini: number): string {
  const antes = texto.slice(0, ini);
  let corte = 0;
  FIM_DE_FRASE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIM_DE_FRASE_G.exec(antes)) !== null) corte = m.index + m[0].length;
  return antes.slice(corte);
}

function trechoDaFraseDepois(texto: string, fim: number): string {
  const depois = texto.slice(fim);
  const m = FIM_DE_FRASE.exec(depois);
  return m ? depois.slice(0, m.index) : depois;
}

/** Posição (índice do "R$") de cada valor que o texto atribui ao PACIENTE. */
export function posicoesDeValorDoPaciente(texto: string): Set<number> {
  const posicoes = new Set<number>();
  if (!texto || !/R\$/i.test(texto) || !ALGUM_SINAL_DO_PACIENTE.test(texto)) return posicoes;

  for (const m of texto.matchAll(VALOR)) {
    const ini = m.index ?? 0;
    const fim = ini + m[0].length;

    // Só o que veio depois do R$ anterior: um "comprovante" lá atrás não vale para este valor.
    const frase = trechoDaFraseAntes(texto, ini);
    const ultimoReal = frase.lastIndexOf('R$');
    const antes = ultimoReal === -1 ? frase : frase.slice(ultimoReal + 2);
    // Pedido de comprovante, condicional ou espera na frase: o R$ não é relato. Preço colado depois do valor: idem.
    if (PEDE_ENVIO.test(frase) || CONDICIONAL_OU_ESPERA.test(frase) || PRECO_COLADO_DEPOIS.test(texto.slice(fim))) continue;

    let doPaciente = false;
    for (const re of ANTES_DO_PACIENTE) {
      const achou = re.exec(antes);
      // "comprovante certinho, com o valor de R$ 200" / "você pagou o sinal de R$ 80": o trecho já fala do preço, não é relato.
      if (!achou || FALA_DO_PRECO_OU_PEDE.test(achou[0])) continue;
      doPaciente = true;
      break;
    }
    if (!doPaciente) {
      const depois = trechoDaFraseDepois(texto, fim);
      doPaciente = DEPOIS_DO_PACIENTE.some((re) => re.test(depois)) || (/comprovante/i.test(antes) && DEPOIS_COM_COMPROVANTE.test(depois));
    }
    if (doPaciente) posicoes.add(ini);
  }
  return posicoes;
}
