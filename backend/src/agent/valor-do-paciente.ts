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
 * Esconder valor da trava é abrir mão de conferi-lo; então só entra o que o texto diz claramente ser do paciente:
 *   ANTES do valor (no mesmo trecho, sem outro R$ no meio):  "comprovante … R$", "você pagou/enviou/mandou/transferiu … R$",
 *                                                           "o valor que veio/caiu/mostrado … R$", "o valor/pagamento foi de R$"
 *   DEPOIS do valor:  "R$ 50 não bate", "R$ 50 que você pagou", "R$ 50 que recebi/caiu"
 * NÃO entra: pedido ("me enviar o comprovante certinho, com o valor de R$ 200" — aí o R$ 200 É o preço), nem trecho que já fala do preço
 * da unidade (antecipado, sinal, garantir, consulta) entre a palavra do comprovante e o valor. Na dúvida, não esconde (= o comportamento de antes).
 */

const VALOR = /R\$\s*(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;

/** Fim de frase: ponto/!/? seguido de espaço, ou quebra de linha. O ponto de "R$ 1.500" não conta (vem colado ao dígito). */
const FIM_DE_FRASE = /[.!?](?=\s)|\n/;

/** Verbos que o paciente fez com o dinheiro. */
const FEZ = '(?:pagou|enviou|mandou|transferiu|depositou|fez)';

/** Trecho, antes do valor, que relata o que o paciente mandou. Termina no valor (`$`). */
const ANTES_DO_PACIENTE: RegExp[] = [
  // "o comprovante é de", "o comprovante mostra", "o valor desse comprovante é", "o comprovante que recebi mostra" …
  /comprovante[^]{0,60}$/i,
  // "você pagou", "você já enviou o Pix de"
  new RegExp(String.raw`\b(?:voc[eê]|vc)\s+(?:j[aá]\s+)?${FEZ}\b[^]{0,25}$`, 'i'),
  // "o valor que veio/caiu/chegou/consta/aparece/mostrado …", "o valor mostrado foi de"
  /\bvalor\s+(?:que\s+)?(?:veio|caiu|chegou|consta|aparece|mostrad[oa]|identificad[oa]|leu)\b[^]{0,25}$/i,
  // "o valor foi de", "o pagamento foi", "o Pix foi de" — passado: o preço da unidade se diz no presente ("é")
  /\b(?:valor|pagamento|pix|dep[oó]sito|transfer[eê]ncia)\s+foi\s+(?:de\s+)?$/i,
];

/** Trecho, depois do valor, que o mostra como coisa do paciente. Começa logo depois do valor. */
const DEPOIS_DO_PACIENTE: RegExp[] = [
  new RegExp(String.raw`^\s*,?\s*(?:que\s+)?(?:voc[eê]|vc)\s+(?:j[aá]\s+)?${FEZ}\b`, 'i'), // "R$ 50 que você pagou"
  /^\s*,?\s*(?:que\s+)?(?:recebi|caiu|chegou|veio|apareceu)\b/i, // "R$ 50 que recebi"
  /^\s*(?:ainda\s+)?n[aã]o\s+(?:bate|confere|corresponde|fecha)\b/i, // "R$ 50 não bate", "R$ 50 ainda não bate" (e NÃO "R$ 200 — então não bate": ali é o preço)
];

/** O trecho entre o "comprovante" e o valor já fala do preço da unidade ou PEDE alguma coisa: então o valor não é o que ele mandou. */
const FALA_DO_PRECO_OU_PEDE =
  /\b(?:antecipad\w*|sinal|garant\w*|consulta|reserva\w*|pagando\s+antes|pagar\s+antes|precis\w+|deve\w*|tem\s+que|tem\s+de|necess\w+|valor\s+(?:certo|correto)|seja|ser[áa]?)\b/i;

/** Pedido de comprovante ("me enviar", "manda o comprovante"): infinitivo ou imperativo, não o passado ("enviou", "mandou"). */
const PEDE_ENVIO = /\b(?:enviar|envie|envia|mandar|mande|manda|reenviar|reenvie|reenvia|anexar|anexe|anexa)\b/i;

function trechoDaFraseAntes(texto: string, ini: number): string {
  const antes = texto.slice(0, ini);
  let corte = 0;
  const re = new RegExp(FIM_DE_FRASE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(antes)) !== null) corte = m.index + m[0].length;
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
  if (!texto || !/R\$/i.test(texto)) return posicoes;

  for (const m of texto.matchAll(VALOR)) {
    const ini = m.index ?? 0;
    const fim = ini + m[0].length;

    // Só o que veio depois do R$ anterior: um "comprovante" lá atrás não vale para este valor.
    const frase = trechoDaFraseAntes(texto, ini);
    const ultimoReal = frase.lastIndexOf('R$');
    const antes = ultimoReal === -1 ? frase : frase.slice(ultimoReal + 2);

    let doPaciente = false;
    for (const re of ANTES_DO_PACIENTE) {
      const achou = re.exec(antes);
      if (!achou) continue;
      const entre = achou[0];
      // "comprovante certinho, com o valor de R$ 200" / "me enviar o comprovante": é pedido, o R$ é o preço.
      if (re === ANTES_DO_PACIENTE[0] && (FALA_DO_PRECO_OU_PEDE.test(entre) || PEDE_ENVIO.test(frase))) continue;
      doPaciente = true;
      break;
    }
    if (!doPaciente) {
      const depois = trechoDaFraseDepois(texto, fim);
      doPaciente = DEPOIS_DO_PACIENTE.some((re) => re.test(depois));
    }
    if (doPaciente) posicoes.add(ini);
  }
  return posicoes;
}
