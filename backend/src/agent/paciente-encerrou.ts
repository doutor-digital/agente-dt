/**
 * O paciente agradeceu, se despediu ou disse que vai se organizar — e a Sofia empurrou horário mesmo assim
 * (auditoria de Araguaína, 21/10/2026).
 *
 * Os casos:
 *  - Lead 28743600, 17/10 18:13–18:14: "Tabom" / "Muito obrigado pelo atendimento" → "Eu que agradeço!… pra eu
 *    garantir sua vaga de segunda (19/10): fica melhor às 08h, 14h ou 16h?". Ela já tinha dito, um minuto antes,
 *    "fico no aguardo do seu retorno". Em 19/10 08:28, de novo: "tabom" → "consegue me dizer se prefere… às 08h, 14h
 *    ou 16h?".
 *  - Lead 28659614: "Ok obrigado" → "Posso contar que você vem na segunda, dia 19/10, às 16h?".
 *
 * Parte da causa é o juiz da pergunta final (cta-final.ts): uma despedida curta e calorosa, sem "?", era refeita
 * "com uma pergunta de continuidade" — e a pergunta que o modelo achava era a do horário.
 *
 * Regra (João): quando o paciente agradece/encerra ou diz que vai se organizar, a resposta é curta e calorosa, SEM
 * nova pergunta de horário — quem retoma é a régua de follow-up. Aqui fica a parte em código: reconhecer o
 * encerramento no histórico (para o prompt e para o juiz da pergunta final) e tirar da resposta pronta o empurrão.
 */
import { ehEncerramento } from '../lib/encerramento.js';
import type { Fala } from './repeticao.js';
import { horariosOferecidos, juntarFrases, perguntaTurnoSemHorario, quebrarEmFrases } from './horario-oferecido.js';

const AGRADECE_OU_DESPEDE =
  /obrigad|brigad|valeu|\bvlw\b|agrade[çc]|\btchau\b|at[ée]\s+(?:mais|logo|breve|amanh[ãa]|a\s+pr[óo]xima)|fica\s+com\s+deus|deus\s+(?:te\s+|lhe\s+)?aben[çc]o|abra[çc]o|\babs\b|bom\s+descanso/i;
/** "Sim, obrigado" responde à pergunta: não é despedida. */
const RESPONDE_QUE_SIM = /(?<![\p{L}])(?:sim|isso|uhum|aham)(?![\p{L}])/iu;
/** Cumprimento sozinho ("bom dia") é retomada, não despedida — quem cuida dele é o bloco <so_um_cumprimento>. */
const CUMPRIMENTO = /(?<![\p{L}])(?:bom\s+dia|boa\s+tarde|boa\s+noite|ol[áa]|oi+e?)(?![\p{L}])/iu;
const VAI_SE_ORGANIZAR =
  /\bvou\s+(?:me\s+)?organizar|\bvou\s+(?:ver|olhar|verificar)\s+(?:aqui\s+)?(?:e\s+(?:te\s+|lhe\s+)?(?:falo|aviso|retorno|chamo)|direitinho|com\s+calma)|\b(?:te|lhe)\s+(?:aviso|falo|chamo|retorno|procuro)\s+(?:depois|mais\s+tarde|amanh[ãa]|semana|quando|assim\s+que)|\bdepois\s+(?:eu\s+)?(?:te\s+|lhe\s+)?(?:aviso|falo|chamo|retorno)\b/i;
/** A última fala da IA já estava fechando ("fico no aguardo", "qualquer coisa é só me chamar"). */
const IA_JA_FECHAVA =
  /fico\s+(?:no\s+)?aguard|fico\s+[àa]\s+(?:sua\s+)?disposi|qualquer\s+(?:coisa|d[úu]vida)|[ée]\s+s[óo]\s+(?:me\s+)?chamar|sem\s+pressa|quando\s+(?:puder|quiser|decidir|estiver)|te\s+espero|at[ée]\s+(?:mais|logo|breve)|bom\s+descanso/i;

export type Encerramento = 'agradeceu' | 'concordou' | 'vai_se_organizar' | null;

/** As falas do paciente deste turno (as seguidas, depois da última fala da IA) e a fala da IA antes delas. */
export function turnoDoPaciente(falas: Fala[]): { textos: string[]; ultimaIa: string | null; inicio: number } {
  let fim = falas.length - 1;
  while (fim >= 0 && falas[fim].papel !== 'paciente') fim--;
  const textos: string[] = [];
  let i = fim;
  for (; i >= 0 && falas[i].papel === 'paciente'; i--) textos.unshift(falas[i].texto);
  // `inicio`: onde começa o turno (a fala da IA que o antecede está em inicio - 1)
  return { textos, ultimaIa: i >= 0 ? falas[i].texto : null, inicio: i + 1 };
}

/**
 * O paciente encerrou neste turno? "agradeceu": agradecimento/despedida (com ok/emoji junto); "concordou": só um "tá
 * bom"/"ok" depois de a IA já ter fechado a conversa; "vai_se_organizar": disse que vê e avisa depois. Pergunta,
 * pedido ou "sim" não é encerramento.
 */
export function pacienteEncerrou(falas: Fala[]): Encerramento {
  const { textos, ultimaIa } = turnoDoPaciente(falas);
  if (textos.length === 0) return null;
  const tudo = textos.join('\n').trim();
  if (!tudo || tudo.includes('?')) return null;
  const linhas = tudo.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (linhas.every((l) => ehEncerramento(l))) {
    if (RESPONDE_QUE_SIM.test(tudo)) return null;
    if (AGRADECE_OU_DESPEDE.test(tudo)) return 'agradeceu';
    if (CUMPRIMENTO.test(tudo)) return null;
    if (ultimaIa && IA_JA_FECHAVA.test(ultimaIa)) return 'concordou';
    return null;
  }
  if (tudo.length <= 220 && VAI_SE_ORGANIZAR.test(tudo)) return 'vai_se_organizar';
  return null;
}

/** O bloco do turno. Vazio quando ele não encerrou. */
export function renderPacienteEncerrou(falas: Fala[] | undefined): string {
  const enc = falas ? pacienteEncerrou(falas) : null;
  if (!enc) return '';
  const oQue =
    enc === 'agradeceu'
      ? 'Ele agradeceu / se despediu nesta mensagem.'
      : enc === 'concordou'
        ? 'Ele só concordou ("tá bom", "ok") depois de você já ter encerrado a conversa.'
        : 'Ele disse que vai se organizar e avisa depois.';
  return (
    '<paciente_encerrou>\n(contado pelo sistema no histórico; vale mais que a regra da pergunta de continuidade)\n' +
    `${oQue}\n` +
    '- Responda CURTO (1 a 2 frases) e caloroso: agradeça de volta e diga que fica à disposição por aqui.\n' +
    '- NÃO ofereça horário, NÃO pergunte "manhã ou tarde", NÃO peça confirmação ("posso contar que você vem?", "fica ' +
    'melhor às…?") e NÃO faça outra pergunta. Quem retoma a conversa depois é o acompanhamento automático.\n' +
    '- Se ele já tem consulta marcada, pode lembrar o dia e a hora numa frase, sem pergunta.\n' +
    '</paciente_encerrou>'
  );
}

const PERGUNTA_QUE_EMPURRA =
  /hor[áa]rio|vaga|marcar|agendar|reservar|garantir|\d{1,2}(?:h|:\d{2})|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|manh[ãa]|tarde|voc[êe]\s+vem\b|consegue\s+vir|pode\s+vir/i;

/** A resposta empurra horário: oferece horário, pergunta o turno ou termina perguntando por dia/hora/vaga. */
export function empurraHorario(resposta: string, agoraLocal: string): boolean {
  if (horariosOferecidos(resposta, agoraLocal).length > 0) return true;
  if (perguntaTurnoSemHorario(resposta, agoraLocal)) return true;
  return quebrarEmFrases(resposta).some((p) => p.frase.includes('?') && PERGUNTA_QUE_EMPURRA.test(p.frase));
}

export const DESPEDIDA_CURTA = 'Eu que agradeço! Qualquer coisa, é só me chamar por aqui ☺';
export const COMBINADO_CURTO = 'Combinado! Fico à disposição, qualquer coisa é só me chamar por aqui ☺';

/** O que sobrou ainda é uma despedida ("eu que agradeço", "fico no aguardo")? Se não, o resto não se sustenta sozinho. */
const AINDA_E_DESPEDIDA =
  /agrade[çc]|obrigad|disposi[çc]|qualquer\s+(?:coisa|d[úu]vida)|me\s+chamar|aguard|imagina|por\s+nada|de\s+nada|feliz|at[ée]\s+(?:mais|logo|breve|l[áa])|abra[çc]o|te\s+espero|combinado|cuide-se|se\s+cuida/i;

/**
 * A resposta sem o empurrão: saem as frases que oferecem horário ou perguntam por dia/hora/vaga (e a linha de
 * botões). Se o que sobra não é mais uma despedida ("Assim já encaminho pra equipe…" sem a pergunta de antes), sai a
 * despedida curta.
 */
export function semEmpurrarHorario(resposta: string, agoraLocal: string, enc: Exclude<Encerramento, null>): string {
  const pedacos = quebrarEmFrases(resposta);
  const comOferta = new Set(horariosOferecidos(resposta, agoraLocal).map((o) => o.frase));
  const ficam = pedacos.filter((p, i) => {
    if (/^\s*\[\[\s*botoes\s*:/i.test(p.frase)) return false;
    if (comOferta.has(i)) return false;
    if (p.frase.includes('?') && (PERGUNTA_QUE_EMPURRA.test(p.frase) || perguntaTurnoSemHorario(p.frase, agoraLocal))) return false;
    return true;
  });
  const resto = juntarFrases(ficam);
  if (!AINDA_E_DESPEDIDA.test(resto)) return enc === 'agradeceu' ? DESPEDIDA_CURTA : COMBINADO_CURTO;
  return resto;
}
