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
import { juntarFrases, quebrarEmFrases } from './horario-oferecido.js';

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

export function pacienteFalouDePs(falas: string[]): boolean {
  return falas.some((f) => PACIENTE_FALOU_DE_PS.test(f ?? ''));
}

/** Frase que aconselha procurar médico, ou opina sobre cirurgia. Sai sempre. */
const OPINA_SOBRE_MEDICO_OU_CIRURGIA = new RegExp(
  [
    // "visto como cirúrgico", "tratamento cirúrgico", "caminho cirúrgico": o adjetivo é sempre opinião sobre o caso
    String.raw`\bcir[uú]rgic[oa]s?\b`,
    String.raw`indica[cç][aã]o\s+(?:de\s+)?cir[uú]rgic`,
    String.raw`(?:tratamento|abordagem|procedimento)\s+cir[uú]rgic`,
    // "vai/pode/talvez precisar de cirurgia", "vai ter que operar", "provavelmente é cirurgia"
    String.raw`\b(?:vai|pode|talvez|provavelmente|tende\s+a|acaba)\s+(?:\w+\s+){0,3}?(?:cirurgia|operar|operad[oa]|opera[cç][aã]o)\b`,
    String.raw`(?<!\bse\s)\b(?:precisa|necessita|requer)\s+(?:de\s+)?(?:cirurgia|opera[cç][aã]o)`,
    String.raw`(?:é|\be)\s+caso\s+de\s+(?:cirurgia|operar)`,
    String.raw`\b(?:procur\w+|busqu\w+|busc\w+|recomend\w+|sugir\w+|aconselh\w+)\s+(?:por\s+)?(?:um|uma|o|a)?\s*(?:outro\s+|outra\s+)?(?:m[eé]dic[oa]|neurologista|ortopedista|neurocirurgi[aã]o|cirurgi[aã]o|cirurgi[aã]|reumatologista)`,
  ].join('|'),
  'i',
);

/** "avaliar SE você vai precisar de cirurgia": dizer que a dúvida existe e é do especialista não é opinar. */
const INCERTEZA_SOBRE_CIRURGIA = /\bse\b[^.!?\n]{0,40}\b(?:cirurgia|cir[uú]rgic[oa]|operar|operad[oa]|opera[cç][aã]o)/i;

export interface SemProntoSocorro {
  texto: string;
  /** As frases que saíram, para o rastro. */
  removidas: string[];
}

/**
 * @param mensagensDoPaciente as últimas mensagens do paciente (texto puro) — de onde sai a exceção do pronto-socorro.
 */
export function semProntoSocorro(texto: string, mensagensDoPaciente: string[] = []): SemProntoSocorro {
  if (!texto) return { texto, removidas: [] };
  const falouDePs = pacienteFalouDePs(mensagensDoPaciente);
  const pedacos = quebrarEmFrases(texto);
  const removidas: string[] = [];
  const ficam = pedacos.filter((p) => {
    const sugerePs = !falouDePs && SUGERE_PRONTO_SOCORRO.test(p.frase);
    if (sugerePs || (OPINA_SOBRE_MEDICO_OU_CIRURGIA.test(p.frase) && !INCERTEZA_SOBRE_CIRURGIA.test(p.frase))) {
      removidas.push(p.frase.trim());
      return false;
    }
    return true;
  });
  if (removidas.length === 0) return { texto, removidas };
  return { texto: juntarFrases(ficam), removidas };
}
