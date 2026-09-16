/**
 * Juiz determinístico da chamada pra ação (16/09/2026).
 *
 * A regra "toda resposta termina com uma pergunta de continuidade" está no prompt desde sempre, e mesmo assim
 * 17% a 33% das respostas da semana saíram sem pergunta (Bebedouro 33%, Balsas 30%, Araguaína 26%). O juiz do
 * dashboard dá nota 5,2 em CTA — a mais baixa. Em vez de um segundo modelo julgando toda mensagem (dobra o custo
 * e soma 3 a 6 s), uma checagem de programa: se a resposta não tem pergunta, nem botões, nem um "me avisa/me
 * confirma", e não é despedida ou confirmação, o modelo refaz UMA vez com a instrução na cara. Custo só nas que
 * falham.
 */

const DESPEDIDA_OU_FECHAMENTO =
  /\b(at[eé]\s+(amanh[aã]|logo|breve|mais|j[aá]|l[aá])|bom\s+descanso|boa\s+(tarde|noite)\s*[!.]?\s*$|tchau|beijo|abra[cç]o|nos\s+vemos|te\s+espero|te\s+esperamos|obrigad[ao]\s+(voc[eê]|por)|de\s+nada|fico\s+[àa]\s+disposi[cç][aã]o|qualquer\s+coisa\s+(me\s+)?(chama|fala|avisa)|confirmad[ao]\b|agendad[ao]\b|anotad[ao]\b|combinado\b|reservad[ao]\b|marcad[ao]\b)/i;

// pedido direto ao paciente sem ponto de interrogação: "me avisa quando fizer o Pix", "escolhe um dos dois"
const CTA_IMPERATIVA =
  /\b(me\s+(avisa|avise|manda|mande|confirma|confirme|conta|conte|fala|fale|diz|diga|responde|responda|chama|chame)|manda\s+(aqui|pra\s+mim)|responde\s+aqui|escolh[ae]\s+(um|uma|o|a|qual)|clica\s+(no|em)|toca\s+(no|em)|s[oó]\s+(me\s+)?(responder|confirmar|escolher|mandar))\b/i;

export interface VereditoCta {
  precisaRefazer: boolean;
  motivo: string | null;
}

/** Decide se a resposta pode sair como está ou se merece UMA reescrita pedindo a pergunta final. */
export function avaliarChamadaFinal(texto: string): VereditoCta {
  const t = (texto ?? '').trim();
  if (t.length < 25) return { precisaRefazer: false, motivo: null };        // "Ok!", "Perfeito 😊": curta demais pra cobrar
  if (t.includes('?')) return { precisaRefazer: false, motivo: null };      // tem pergunta em algum lugar: basta
  if (/\[\[\s*botoes\s*:/i.test(t)) return { precisaRefazer: false, motivo: null };
  if (CTA_IMPERATIVA.test(t)) return { precisaRefazer: false, motivo: null };
  if (DESPEDIDA_OU_FECHAMENTO.test(t)) return { precisaRefazer: false, motivo: null };
  return { precisaRefazer: true, motivo: 'sem pergunta, sem botões e sem pedido ao paciente' };
}

/** Instrução curta que vai junto da resposta reprovada — só ajusta o fecho, não muda o conteúdo. */
export const INSTRUCAO_REFAZER_CTA =
  '[instrução interna, não é fala do paciente] Sua resposta acima terminou sem pergunta de continuidade nem próximo passo. ' +
  'Reescreva a MESMA resposta: mantenha o conteúdo e o tom, e termine com UMA pergunta curta e relevante ' +
  '(ou a linha [[botoes: …]] quando a pergunta for fechada). Responda só com a mensagem final.';
