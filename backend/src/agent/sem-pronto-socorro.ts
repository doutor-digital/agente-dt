/**
 * Trava DETERMINÍSTICA de saída: a Sofia não sugere pronto-socorro e não opina sobre médico nem cirurgia.
 *
 * Decisão do João (26/10/2026, itens 1 e 2 da conferência da Suzanne). A regra de 21/10 estava no prompt e os
 * casos aconteceram do mesmo jeito (Marabá, ITZ, Canaã, Taubaté): o texto vem do modelo, de mensagem pronta
 * cadastrada na unidade ou de modelo de nota, e prompt sozinho não segura nenhum dos três. Aqui a frase que
 * cita pronto-socorro/UPA/emergência, aconselha procurar médico ou opina sobre cirurgia SAI da resposta antes
 * de ir ao paciente — o resto da mensagem fica.
 *
 * Exceção: se o PRÓPRIO paciente falou em pronto-socorro/hospital/emergência nas últimas mensagens, a frase de
 * pronto-socorro fica — o prompt manda a Sofia dizer que, se ele sente que não dá para esperar, pode ir, e é
 * isso que não pode ser cortado. Opinião sobre médico e cirurgia sai sempre.
 */
import { juntarFrases, quebrarEmFrases, type Pedaco } from './horario-oferecido.js';

/** "(logo) (para/ao/no) (o/um) hospital": o destino depois do verbo de ir, sem palavra no meio. */
const HOSPITAL_DESTINO = String.raw`(?:(?:logo|agora|direto|imediatamente)\s+)?(?:(?:para|pra|pro|a|ao|à|no|na|num|numa|em)\s+)?(?:o\s+|um\s+|uma\s+|a\s+)?(?:hospital|santa\s+casa|policl[ií]nica)`;

/** Frase que SUGERE pronto-socorro (ou equivalente). */
const SUGERE_PRONTO_SOCORRO = new RegExp(
  [
    String.raw`pronto[\s-]*(?:socorro|atendimento)`,
    String.raw`\bUPA\b`,
    String.raw`\bSAMU\b`,
    String.raw`\bemerg[eê]ncia`,
    String.raw`\b(?:sala|setor|servi[cç]o|atendimento|ala|plant[aã]o)\s+de\s+urg[eê]ncia`,
    String.raw`\bem\s+caso\s+de\s+urg[eê]ncia`,
    String.raw`\bambul[aâ]ncia`,
    // "vá/procure/corra ao hospital": verbo de ir COLADO no destino — "o doutor vai atender perto do Hospital X" e
    // "o endereço correto é ao lado do Hospital X" são endereço.
    String.raw`\b(?:v[aá]|v[aã]o|vai|ir|procur\w+|busqu\w+|dirij\w+|corra|corram|recomend\w+|sugir\w+|aconselh\w+)\s+${HOSPITAL_DESTINO}`,
  ].join('|'),
  'i',
);

/**
 * O paciente falou em ir a pronto-socorro/hospital/emergência. "Hospital" sozinho não vale ("trabalho num hospital",
 * "já fui no hospital semana passada"): só com verbo de ir, ou as palavras que já são de pronto-socorro.
 */
const PACIENTE_FALOU_DE_PS = new RegExp(
  [
    String.raw`pronto[\s-]*(?:socorro|atendimento)`,
    String.raw`\bUPA\b`,
    String.raw`\bSAMU\b`,
    String.raw`\bemerg[eê]ncia`,
    String.raw`\bambul[aâ]ncia`,
    String.raw`\b(?:ir|vou|vamos|v[aá]|devo|deveria|preciso|precisa|corr\w+|levar|levo)\s+${HOSPITAL_DESTINO}`,
  ].join('|'),
  'i',
);

/** "fui ao pronto-socorro semana passada": visita passada. */
const PASSADO = /\b(?:fui|fomos|estive|estivemos|passei|passamos|j[aá]\s+fui|semana\s+passada|m[eê]s\s+passado|ontem|anteontem|h[aá]\s+\w+\s+(?:dias|semanas|meses|anos))\b/i;
/** Pergunta se deve ir, ou diz que vai AGORA. */
const INTENCAO_AGORA = /\b(?:devo|deveria|vou|vamos|irei|preciso\s+ir|precisa\s+ir|posso\s+ir|tenho\s+que\s+ir|melhor\s+ir|vale\s+a\s+pena|chamo|chamar|corro|me\s+levem|levar)\b|\b(?:preciso|precisa|precisamos)\s+(?:de\s+)?(?:um\s+|o\s+|uma\s+|a\s+)?(?:pronto|upa\b|samu|emerg|ambul|hospital)|(?:^|\s)[eé]\s+caso\b|\bir\s+(?:ao?|no|na|pro|pra|num|numa)\b/i;
/** Visita passada MAS pergunta se volta: "já fui no pronto socorro e mandaram pra casa, devo voltar?" */
const VOLTAR = /\b(?:devo|vou|preciso|posso)\s+(?:voltar|ir)\b|\bvoltar\s+(?:ao?|no|na|pro|pra|l[aá])\b|\bvolto\b/i;

/**
 * O paciente perguntou se deve ir, ou disse que vai AGORA? Visita passada ("fui ao pronto-socorro ontem e disseram
 * que preciso de ressonância") não abre a exceção — nem "preciso"/"posso" soltos. Só a intenção de agora (ou a
 * pergunta se volta).
 */
export function pacienteFalouDePs(falas: string[]): boolean {
  return falas.some((f) => {
    const frases = frasesSemAbreviacao(f ?? '').filter(({ frase }) => PACIENTE_FALOU_DE_PS.test(frase));
    // "Fui ao PS ontem. Hoje piorou, volto lá?": a visita passada e a pergunta se volta podem estar em frases diferentes.
    // Por oração: "ontem fui ao hospital, hoje vou ao hospital porque a dor piorou" tem uma visita passada E uma intenção de agora.
    return frases.some(({ frase }) =>
      frase.split(/[,;]|\s+mas\s+/).some((oracao) => PACIENTE_FALOU_DE_PS.test(oracao) && (PASSADO.test(oracao) ? VOLTAR.test(f) : INTENCAO_AGORA.test(oracao))),
    );
  });
}

/** "Av.", "Dr.", "Rod."… não terminam frase: "Fica na Av. Brasil" virava "Fica na Av." + "Brasil…". */
const ABREVIACAO_NO_FIM = /\b(?:Av|Dr|Dra|Sr|Sra|Srta|Prof|Profa|Rod|Pç|Pça|Est|Al|Trav|Tv|Jd|Vl|Sta|Sto|Ed|Apt|Ap|Sl|Cj|Qd|Lt|Cel|Ltda|Cia|Eng|Pe)\.$/;

/** `quebrarEmFrases` sem partir depois de abreviação de endereço ou de título. */
function frasesSemAbreviacao(texto: string): Pedaco[] {
  const out: Pedaco[] = [];
  for (const p of quebrarEmFrases(texto)) {
    const ant = out[out.length - 1];
    if (ant && ABREVIACAO_NO_FIM.test(ant.frase.trimEnd())) ant.frase += p.sep + p.frase;
    else out.push({ ...p });
  }
  return out;
}

/** Frase que aconselha procurar médico, ou opina sobre cirurgia. Sai sempre. */
const OPINA_SOBRE_MEDICO_OU_CIRURGIA = new RegExp(
  [
    // "visto como cirúrgico", "tratamento cirúrgico", "caminho cirúrgico": o adjetivo é opinião sobre o caso — menos
    // "não cirúrgico" (o método da clínica) e "pós-cirúrgico" (quem já operou, que a clínica avalia ou não).
    String.raw`(?<!\bn[aã]o\s)(?<!\bp[oó]s[-\s]?)(?<!\bpr[eé][-\s]?)(?<!\bsem\s)\bcir[uú]rgic[oa]s?\b`,
    String.raw`indica[cç][aã]o\s+(?:de\s+)?cir[uú]rgic`,
    // "vai/pode/talvez precisar de cirurgia", "vai ter que operar", "provavelmente é cirurgia"
    String.raw`\b(?:vai|pode|talvez|provavelmente|tende\s+a|acaba)\s+(?:\w+\s+){0,3}?(?:cirurgia|operar|operad[oa]|opera[cç][aã]o)\b`,
    String.raw`(?<!\bse\s)\b(?:precisa|necessita|requer)\s+(?:de\s+)?(?:cirurgia|opera[cç][aã]o)`,
    String.raw`(?:é|\be)\s+caso\s+de\s+(?:cirurgia|operar)`,
    String.raw`\b(?:procur\w+|busqu\w+|busc\w+|recomend\w+|sugir\w+|aconselh\w+)\s+(?:por\s+)?(?:um|uma|o|a)?\s*(?:outro\s+|outra\s+)?(?:m[eé]dic[oa]|neurologista|ortopedista|neurocirurgi[aã]o|cirurgi[aã]o|cirurgi[aã]|reumatologista|urologista)`,
  ].join('|'),
  'i',
);

/** "avaliar SE você vai precisar de cirurgia": dizer que a dúvida existe e é do especialista não é opinar. */
const INCERTEZA_SOBRE_CIRURGIA = /\bse\b[^.!?\n]{0,40}\b(?:cirurgia|cir[uú]rgic[oa]|operar|operad[oa]|opera[cç][aã]o)/i;

/** "em frente à UPA", "ao lado do Pronto Socorro Municipal": ponto de referência do endereço, não conselho. */
const REFERENCIA_DE_ENDERECO = /(?:em\s+frente|ao\s+lado|perto|pr[oó]xim[oa]|atr[aá]s|do\s+lado|defronte|vizinh[oa]|esquina|fundos)\s+(?:d[aoe]s?|ao?s?|à)\s+(?:\S+\s+){0,2}$/i;
/** "já ter precisado ir à UPA duas vezes": a IA repetindo o que o paciente contou, sem mandar ninguém. */
const RELATO_DO_PASSADO = /\b(?:j[aá]\s+(?:ter\s+)?(?:precisou|precisado|ido|foi|fui|esteve)|ter\s+(?:ido|precisado)|foi\s+(?:na|à|ao)|foram\s+(?:na|à|ao)|esteve\s+(?:na|no)|passou\s+(?:na|pela|pelo))/i;
const VERBO_DE_CONSELHO = /\b(?:procur\w+|v[aá]\b|vai\s+(?:ao?|no|na)|busqu\w+|corra|chame|ligue|pode\s+(?:ir|procurar)|deve\s+ir|melhor\s+ir|recomend\w+|sugir\w+|lembr\w+|se\s+piorar|se\s+sentir)/i;

/** A frase (ou o trecho) manda ao pronto-socorro? Referência de endereço e relato do passado não contam. */
function sugerePs(trecho: string): boolean {
  const todas = new RegExp(SUGERE_PRONTO_SOCORRO.source, 'gi');
  for (const m of trecho.matchAll(todas)) {
    const antes = trecho.slice(Math.max(0, (m.index ?? 0) - 45), m.index ?? 0);
    if (REFERENCIA_DE_ENDERECO.test(antes)) continue;
    if (RELATO_DO_PASSADO.test(trecho) && !VERBO_DE_CONSELHO.test(trecho)) continue;
    return true;
  }
  return false;
}

function opina(trecho: string): boolean {
  return OPINA_SOBRE_MEDICO_OU_CIRURGIA.test(trecho) && !INCERTEZA_SOBRE_CIRURGIA.test(trecho);
}

export interface SemProntoSocorro {
  texto: string;
  /** Os trechos que saíram, para o rastro. */
  removidas: string[];
}

/**
 * Separadores fortes dentro de uma frase: " - ", "—", ";". Parênteses são tratados à parte. Dois-pontos NÃO: o que vem
 * antes dele costuma ser a abertura do conselho ("o mais importante agora é você não esperar: procure…").
 */
const SEPARADOR_FORTE = /(\s[-–—]\s|\s?[–—]\s?|;\s)/;

const FIM_DA_FRASE = /([.!?…]*[\s\p{Extended_Pictographic}\uFE0F]*)$/u;

/**
 * Corta da frase só o TRECHO que manda ao pronto-socorro ou opina: parênteses, e o pedaço entre separadores fortes
 * (" — se a dor estiver insuportável antes disso, pode procurar um pronto-socorro"). Se sobrar menos de 4 palavras, ou a
 * frase não tiver separador, a frase inteira sai. `null` = a frase inteira sai.
 */
function cortarTrecho(frase: string, deveCortar: (t: string) => boolean): string | null {
  let f = frase.replace(/\s*\([^)]*\)/g, (par) => (deveCortar(par) ? '' : par));
  const fim = FIM_DA_FRASE.exec(f)?.[1] ?? '';
  const partes = f.split(SEPARADOR_FORTE); // [seg, sep, seg, sep, ...]
  const segmentos = partes.filter((_, i) => i % 2 === 0);
  const ficam = segmentos.filter((seg) => !deveCortar(seg));
  if (ficam.length < segmentos.length) f = ficam.join(', ').trim(); // só reescreve se um trecho saiu
  const resto = f.replace(FIM_DA_FRASE, '').trim();
  if (deveCortar(resto) || resto.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length < 4) return null;
  const limpo = resto.replace(/[,;:\s–—-]+$/u, '');
  // sempre afirmação: a interrogação ou a exclamação do original era do trecho que saiu
  const comPonto = /[.!?…]$/.test(limpo) ? limpo : `${limpo}.`;
  const maiuscula = comPonto.replace(/^(\P{L}*)(\p{Ll})/u, (_, pre: string, c: string) => pre + c.toUpperCase());
  return `${maiuscula}${fim.replace(/^[.!?…]*/, '')}`.trimEnd();
}

/**
 * @param mensagensDoPaciente as falas do paciente deste turno (só dele: `soFalaDoPaciente`) — de onde sai a exceção.
 */
export function semProntoSocorro(texto: string, mensagensDoPaciente: string[] = []): SemProntoSocorro {
  if (!texto) return { texto, removidas: [] };
  const falouDePs = pacienteFalouDePs(mensagensDoPaciente);
  const deveCortar = (t: string) => (!falouDePs && sugerePs(t)) || opina(t);
  const removidas: string[] = [];
  const ficam: Pedaco[] = [];
  for (const p of frasesSemAbreviacao(texto)) {
    if (!deveCortar(p.frase)) {
      ficam.push(p);
      continue;
    }
    removidas.push(p.frase.trim());
    const sobra = cortarTrecho(p.frase, deveCortar);
    if (sobra) ficam.push({ ...p, frase: sobra });
  }
  if (removidas.length === 0) return { texto, removidas };
  return { texto: juntarFrases(ficam), removidas };
}
