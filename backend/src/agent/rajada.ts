/**
 * Várias mensagens seguidas: a dor no meio não pode se perder no "tudo bem" do fim.
 *
 * Araguaína, lead 28681456 (15/10/2026). A paciente mandou, em três minutos: "Na cintura", "Ai desce pras pernas",
 * "Mim falou as pernas" (= me faltaram as pernas), "Quer não andei" (= quase não andei), "Boa noite", "Tudo bem",
 * "Comigo tudo a não ser essa dor", "Esta tudo bem graças a Deus". A Sofia respondeu: "Que bom, Selma, graças a
 * Deus mesmo! Agora vamos cuidar dessa dor também… você mora aqui em Araguaína?". Duas causas:
 *  - a rajada virou vários turnos, e as respostas do meio foram seguradas (o paciente escrevia enquanto elas
 *    nasciam) mas ficaram no histórico como se tivessem saído — ver `guardarRespostaSegurada` (entrega-falha.ts)
 *    e `falasDoHistorico` (repeticao.ts);
 *  - nada dizia que, numa rajada, a queixa vale mais que o cumprimento do fim.
 *
 * Aqui, em código: as falas do paciente desde a última resposta que ele LEU. Se alguma traz dor, limitação ou sinal
 * clínico e a última é só cumprimento/"tudo bem", entra um bloco no turno mandando acolher a queixa primeiro.
 * Puro, sobre a lista de falas.
 */
import { ehSoCumprimento } from '../lib/pediu-para-parar.js';
import type { Fala } from './repeticao.js';

/**
 * Perna que faltou ou falhou, não conseguir andar, travar — em linguagem do dia a dia e com o erro de digitação
 * que aparece de verdade ("mim falou as pernas", "quer não andei"). É o que pede a pergunta dos sinais de alerta.
 */
const LIMITACAO = new RegExp(
  [
    // "me faltou a perna", "faltaram as pernas", "mim falou as pernas" (falou = faltou, erro de digitação)
    String.raw`\bfal(?:t)?(?:ou|aram|aro|ando|am)\s+(?:as\s+|a\s+|minhas?\s+|uma\s+das\s+)?pernas?\b`,
    String.raw`\bpernas?\s+(?:me\s+)?(?:falh(?:ou|aram|ando|a|am)|faltou|faltaram|bambe(?:ou|aram|ando|ia|ou)|travou|travaram|sumiu|sumiram|amoleceu|amoleceram|n[aã]o\s+(?:aguenta|obedece|firma))`,
    String.raw`\bfalh(?:ou|aram)\s+(?:as\s+|a\s+|minhas?\s+)?pernas?\b`,
    // "quase não andei", "quer não andei", "não consigo andar", "mal consigo andar"
    String.raw`\bn[aã]o\s+(?:andei|ando|t[oô]\s+andando|estou\s+andando|consigo\s+(?:andar|ficar\s+em\s+p[eé]|levantar|me\s+mexer|sair\s+da\s+cama)|consegui\s+(?:andar|levantar))(?![\wÀ-ÿ])`,
    String.raw`\bmal\s+(?:consigo|consegui|t[oô]\s+conseguindo)\s+(?:andar|levantar|me\s+mexer)`,
    String.raw`\btrav(?:ei|ou|ada|ado|aram)\b`,
    String.raw`\b(?:sem|perdi\s+a|perdendo\s+a|perdeu\s+a)\s+for[cç]a\b`,
  ].join('|'),
  'i',
);

/** Dor, onde dói, diagnóstico, sintoma — o assunto clínico da mensagem. */
const QUEIXA = new RegExp(
  [
    String.raw`\bdor(?:es)?\b|\bd[oó]i\b|\bdoendo\b|\bdolorid`,
    String.raw`\bdesce\s+(?:pra|para|pras|pros|nas?|nos?|at[eé])\b`,
    String.raw`formig|dorm[eê]ncia|dormente|adormec|fraqueza|inchad|inflamad|queimaç`,
    String.raw`h[ée]rnia|\bernia|ci[aá]tic|bico\s+de\s+papagaio|artrose|escoliose|protus|abaulament`,
    String.raw`\bcoluna\b|lombar|cervical|\bcintura\b|\bcostas\b|pesco[cç]o|quadril|\bnervo\b`,
    String.raw`\bca(?:[ií]|iu)(?![\wÀ-ÿ])|\bqueda\b|pancada|me\s+quebrei|se\s+quebrou`,
  ].join('|'),
  'i',
);

/** "Tudo bem", "graças a Deus", "amém", "obrigada" — conversa de cortesia, sem assunto. */
const CORTESIA =
  /^(?:e\s+)?(?:(?:est[aá]|t[aá]|ta|aqui|comigo)\s+)?(?:tudo\s+(?:bem|bom|certo|[oó]timo|tranquilo|em\s+paz)|gra[cç]as\s+a\s+deus|am[eé]m|obrigad[oa]|ok|okay|beleza|blz|show|que\s+bom|e\s+(?:voc[eê]|vc|a\s+senhora|o\s+senhor))(?:\s+(?:gra[cç]as\s+a\s+deus|e\s+(?:voc[eê]|vc|a[ií])|tamb[eé]m|sim|viu|amiga|querida))*[\s!.?😊🙏❤️]*$/iu;

export function temLimitacao(linha: string): boolean {
  return LIMITACAO.test(linha);
}

export function temQueixaClinica(linha: string): boolean {
  return LIMITACAO.test(linha) || QUEIXA.test(linha);
}

/** Só cortesia: cumprimento, "tudo bem", "graças a Deus" — e nada clínico. */
export function soCortesia(linha: string): boolean {
  if (temQueixaClinica(linha)) return false;
  const l = linha.trim();
  // só "?" ou só emoji não é cortesia: é ele cobrando a resposta
  return /\p{L}/u.test(l) && (ehSoCumprimento(l) || CORTESIA.test(l));
}

/** As marcas do sistema ("[áudio do cliente]:", "[imagem do cliente]: …") não são fala dele. */
function semMarcas(texto: string): string {
  return texto.replace(/\[(?:áudio|imagem)[^\]]*\]:?/gi, ' ');
}

/**
 * As mensagens do paciente desde a última fala da IA, linha a linha (a rajada juntada pelo coalescer vem separada
 * por linha em branco). Olha até a última fala do paciente: no meio do turno a IA pode já ter escrito algo depois.
 */
export function linhasSemResposta(falas: ReadonlyArray<Fala>): string[] {
  let fim = falas.length - 1;
  while (fim >= 0 && falas[fim].papel !== 'paciente') fim--;
  if (fim < 0) return [];
  let ini = fim;
  while (ini - 1 >= 0 && falas[ini - 1].papel === 'paciente') ini--;
  return falas
    .slice(ini, fim + 1)
    .flatMap((f) => semMarcas(f.texto).split(/\n+/))
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * O que o paciente escreveu desde a última resposta que leu, num texto só — para o teste de "só um cumprimento":
 * quem mandou a dor e depois "boa noite" não mandou só um cumprimento. Nulo sem histórico.
 */
export function textoSemResposta(falas: ReadonlyArray<Fala> | undefined): string | null {
  if (!falas || falas.length === 0) return null;
  const linhas = linhasSemResposta(falas);
  return linhas.length ? linhas.join('\n') : null;
}

/** A rajada terminou em cortesia, com queixa no meio? Devolve as linhas da queixa (vazio = nada a fazer). */
export function queixasEsquecidas(falas: ReadonlyArray<Fala>): string[] {
  const linhas = linhasSemResposta(falas);
  if (linhas.length < 2) return [];
  if (!soCortesia(linhas[linhas.length - 1])) return [];
  return linhas.slice(0, -1).filter(temQueixaClinica);
}

/** Quantas falas (turnos) do paciente seguidas, desde a última fala da IA que ele leu. */
export function turnosSemResposta(falas: ReadonlyArray<Fala>): number {
  let fim = falas.length - 1;
  while (fim >= 0 && falas[fim].papel !== 'paciente') fim--;
  let n = 0;
  for (let i = fim; i >= 0 && falas[i].papel === 'paciente'; i--) n++;
  return n;
}

const MAX_QUEIXAS = 5;
const MAX_MENSAGENS = 10;
const citar = (l: string) => `  > "${l.slice(0, 120)}"`;

/**
 * O bloco do turno. Vazio quando não há nada a dizer — bloco que aparece sempre vira ruído. Duas situações:
 *  - mais de um turno dele sem resposta lida (as respostas do meio foram seguradas): lista o que ele mandou e manda
 *    responder a tudo — no histórico do modelo as respostas seguradas continuam lá, parecendo enviadas;
 *  - `clinica` e a rajada terminou em cortesia com queixa no meio: manda acolher a queixa primeiro.
 */
export function renderRajada(falas: ReadonlyArray<Fala> | undefined, opcoes: { clinica: boolean }): string {
  if (!falas || falas.length === 0) return '';
  const varios = turnosSemResposta(falas) >= 2;
  const queixas = opcoes.clinica ? queixasEsquecidas(falas) : [];
  if (!varios && queixas.length === 0) return '';
  const out = [
    '<rajada_sem_resposta>',
    '(ALTA PRIORIDADE — contado pelo sistema; vale mais que <so_um_cumprimento> e que responder só à última mensagem)',
  ];
  if (varios) {
    out.push(
      'Desde a última resposta que ele RECEBEU, ele mandou tudo isto. As respostas que você escreveu no meio NÃO saíram',
      '(ele mandava outra mensagem enquanto elas nasciam): ele não leu nenhuma.',
      ...linhasSemResposta(falas).slice(-MAX_MENSAGENS).map(citar),
      '- Responda a TODAS numa mensagem só, na ordem em que vieram — não só à última. Nada de "como eu falei".',
    );
  }
  if (queixas.length > 0) {
    out.push(
      'Ele terminou com cumprimento ou "tudo bem", mas no meio contou da dor ou de uma limitação:',
      ...queixas.slice(-MAX_QUEIXAS).map(citar),
      '- Acolha ISSO primeiro, numa frase, com as palavras dele. NUNCA responda só ao "tudo bem" / "graças a Deus".',
      '- O cumprimento, no máximo de passagem, depois.',
    );
    if (queixas.some(temLimitacao)) {
      out.push(
        '- Perna que faltou ou falhou, não conseguir andar ou ter travado: faça a pergunta de sinais de alerta, UM sinal',
        '  por vez — comece pela força da perna ("a perna ficou fraca, sem força?") — e siga <sinal_de_alerta>.',
      );
    }
  }
  out.push('</rajada_sem_resposta>');
  return out.join('\n');
}
