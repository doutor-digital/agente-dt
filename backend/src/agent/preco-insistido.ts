/**
 * Paciente que INSISTE no preço recebe o valor na hora (item 9 da lista de 21/10/2026).
 *
 * A regra da rede continua "dor primeiro" (decisão do João, 21/10): na 1ª pergunta de preço, sem saber da queixa,
 * a Sofia acolhe e faz UMA pergunta sobre a dor. Mas a mesma regra manda que, se ele insistir — perguntou de novo,
 * "só quero saber o valor" —, o valor sai na hora. Isso foi desobedecido de 11 a 29 vezes em 01–20/10: o paciente
 * perguntava o preço pela 2ª vez e a resposta era outra pergunta (o nome, a dor, "manhã ou tarde?"). Num caso a IA
 * chegou a escrever o próprio raciocínio: "ele já perguntou de forma insistente… vou responder, mas antes preciso
 * pelo menos do nome dele".
 *
 * A insistência dá para ver em código, no histórico: é a 2ª fala do paciente perguntando o preço, ou uma fala que
 * diz com todas as letras que só quer o valor. Quando ela aparece, entra um bloco curto NO TURNO, com o valor da
 * unidade já escrito — o modelo não precisa decidir se "insistiu" nem procurar o número.
 */
import type { Fala } from './repeticao.js';

/**
 * Pergunta de preço numa linha da fala do paciente. "Quanto tempo" não é preço; "qual o valor", "quanto é",
 * "e o valor?", "gostaria de saber o valor" são. "O valor" solto só conta com "?" na linha: "achei caro o valor"
 * é objeção, não pergunta, e "já paguei o valor" menos ainda.
 */
const PRECO_FORTE = new RegExp(
  [
    String.raw`\bqual\s+(?:[eé]\s+|seria\s+|fica\s+)?(?:o\s+|os\s+)?(?:valor(?:es)?|pre[cç]os?|custo)\b`,
    // fim de palavra à mão: o \b do JS não enxerga "é", "está", "tá" (letra acentuada não é \w)
    String.raw`\bquanto\s+(?:[eé]|e|fica|sai|custa|cobra|cobram|est[aá]|t[aá]|seria|vai\s+ficar|vai\s+sair|pago|vou\s+pagar)(?![\wÀ-ÿ])`,
    String.raw`\bcusta\s+quanto\b`,
    String.raw`\bsaber\s+(?:o|os|do|dos|sobre\s+o)\s+(?:valor(?:es)?|pre[cç]os?)\b`,
    // "me passa o valor", "pode me informar o preço" — mas "meu marido vai passar o valor" (vai pagar) não
    String.raw`(?:^|\bme\s+|\bpode\s+(?:me\s+)?|\bpoderia\s+(?:me\s+)?|\bconsegue\s+(?:me\s+)?)(?:passa(?:r)?|passe|informa(?:r)?|informe|diz(?:er)?|diga|fala(?:r)?|fale|manda(?:r)?|mande)\s+(?:(?:o|os)\s+)?(?:valor(?:es)?|pre[cç]os?)\b`,
    String.raw`^\s*(?:e\s+|mas\s+(?:e\s+)?)?(?:o\s+|os\s+)?(?:valor(?:es)?|pre[cç]os?)\s*[?!.]*\s*$`,
  ].join('|'),
  'im',
);
const PRECO_FRACO = /\b(?:o|os)\s+(?:valor(?:es)?|pre[cç]os?)\b|\bvalor(?:es)?\s+d[aoe]s?\s+(?:consulta|avalia[cç][aã]o|tratamento|sess[aã]o|sess[oõ]es|atendimento)\b/i;

function linhaPerguntaPreco(linha: string): boolean {
  return PRECO_FORTE.test(linha) || (PRECO_FRACO.test(linha) && linha.includes('?'));
}

/** Ele diz com todas as letras que quer o valor antes de qualquer outra coisa. */
const INSISTENCIA_EXPLICITA = [
  /\bs[oó]\s+(?:quero|queria|preciso|gostaria\s+de)\s+(?:saber\s+)?(?:o|os|do|dos)\s+(?:valor|pre[cç]o)/i,
  /\b(?:s[oó]|apenas|somente)\s+(?:me\s+)?(?:diz|diga|fala|fale|passa|passe|informa|informe|manda|mande)\s+(?:o|os)\s+(?:valor|pre[cç]o)/i,
  /\b(?:primeiro|antes)\s+(?:eu\s+)?(?:quero|queria|preciso|gostaria\s+de)\s+saber\s+(?:o|os|do|dos|qual\s+[eé]\s+o)\s+(?:valor|pre[cç]o)/i,
  /\bn[aã]o\s+(?:quero|vou)\s+(?:falar|contar|dizer|explicar)\b/i,
  /(?:valor|pre[cç]o|custa)[^?\n]*\?{2,}/i,
];

/** "Eu perguntei o valor", "responde minha pergunta": cobra a resposta de uma pergunta de preço já feita. */
const COBRA_RESPOSTA = /\b(?:j[aá]\s+)?perguntei\s+(?:o|os|qual|quanto|sobre|do|dos|isso|antes)\b|\bresponde(?:r|a)?\s+(?:a\s+)?(?:minha\s+)?pergunta\b|\bn[aã]o\s+(?:me\s+)?respondeu\b/i;

/** Valor em reais dito pela IA. */
const VALOR_DITO = /R\$\s*\d/;

function limpa(texto: string): string {
  // as marcas do sistema ("[áudio do cliente]:", "[imagem do cliente]: …") não são fala dele
  return texto.replace(/\[(?:áudio|imagem)[^\]]*\]:?/gi, ' ');
}

function linhas(texto: string): string[] {
  return limpa(texto)
    .split(/\n+|(?<=[?!.])\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function perguntaPreco(texto: string): boolean {
  return linhas(texto).some(linhaPerguntaPreco);
}

function contarPerguntasDePreco(texto: string): number {
  return linhas(texto).filter(linhaPerguntaPreco).length;
}

export type Insistencia = 'perguntou_de_novo' | 'pediu_so_o_valor';

/**
 * A fala deste turno insiste no preço? Olha só até a última fala do paciente (no meio do turno a IA pode já ter
 * escrito algo depois dela).
 */
export function insistenciaNoPreco(falas: Fala[]): Insistencia | null {
  let fim = falas.length - 1;
  while (fim >= 0 && falas[fim].papel !== 'paciente') fim--;
  if (fim < 0) return null;
  const atual = falas[fim].texto;
  const antes = falas.slice(0, fim);
  const precoAgora = perguntaPreco(atual);

  if (precoAgora && INSISTENCIA_EXPLICITA.some((re) => re.test(limpa(atual)))) return 'pediu_so_o_valor';
  if (precoAgora && contarPerguntasDePreco(atual) >= 2) return 'perguntou_de_novo';

  // a última pergunta de preço que ele fez antes deste turno
  let ultimaPreco = -1;
  for (let i = antes.length - 1; i >= 0; i--) {
    if (antes[i].papel === 'paciente' && perguntaPreco(antes[i].texto)) {
      ultimaPreco = i;
      break;
    }
  }
  if (ultimaPreco < 0) return null;
  if (precoAgora) return 'perguntou_de_novo';

  // "Eu perguntei o valor" / "responde minha pergunta", sem repetir a palavra: só conta se a IA ainda não disse
  // valor nenhum depois da pergunta dele.
  if (COBRA_RESPOSTA.test(limpa(atual))) {
    const valorDepois = antes.slice(ultimaPreco + 1).some((f) => f.papel === 'ia' && VALOR_DITO.test(f.texto));
    if (!valorDepois) return 'perguntou_de_novo';
  }
  return null;
}

export interface ValorDaConsulta {
  /** Os valores, já em frase ("R$ 350 no dia, ou R$ 250 pagando antes no Pix"). Nulo quando as fontes não dão os dois com segurança. */
  frase: string | null;
}

/**
 * O bloco do turno. Vazio quando não houve insistência. `frase` vem das fontes da unidade (precosDaConsulta); sem
 * ela, o bloco manda dizer o valor das fontes, sem número aqui — inventar número é pior que mandar procurar.
 */
export function renderPrecoInsistido(falas: Fala[], valor: ValorDaConsulta): string {
  const insistiu = insistenciaNoPreco(falas);
  if (!insistiu) return '';
  const porque =
    insistiu === 'pediu_so_o_valor'
      ? 'Ele pediu o valor com todas as letras.'
      : 'Ele já tinha perguntado o valor antes e está perguntando de novo.';
  const comoDizer = valor.frase
    ? `  > "A consulta com o nosso especialista é ${valor.frase}."`
    : '  > o valor da consulta com o nosso especialista que está nas suas fontes, inteiro (os dois valores, se houver).';
  return [
    '<preco_insistido>',
    '(ALTA PRIORIDADE — neste turno vale mais que "dor primeiro")',
    `${porque} Acabou o adiamento: o valor vem AGORA, na PRIMEIRA frase da resposta, inteiro:`,
    comoDizer,
    '- NADA antes do valor: nem pergunta de nome, de dor, de cidade, nem horário. Não diga que "depende", que a equipe',
    '  informa ou que vai explicar depois.',
    '- Se ele contou que tem plano e as suas fontes têm valor com a carteirinha, diga esse valor também.',
    '- Só DEPOIS do valor, UMA pergunta curta: sobre a dor, se você ainda não sabe; senão, um horário.',
    '</preco_insistido>',
  ].join('\n');
}
