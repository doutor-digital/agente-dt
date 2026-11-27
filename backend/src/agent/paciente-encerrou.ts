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

// ---------------------------------------------------------------------------------------------------------------------
// Chave `adiamento-propoe-dia` (ADIAMENTO_PROPOE_DIA_SLUGS), decisão do João de 27/11/2026.
//
// Quem ADIA dizendo o motivo ou o quando ("vou falar com meu marido", "só recebo dia 5", "estou viajando") ouvia "te procuro no dia X" e a
// conversa parava: em 30 dias de produção, 187 conversas com frase assim e 133 nunca marcaram. Com a chave ligada a Sofia propõe UM dia e DOIS
// horários reais depois do motivo e só marca se ele escolher. O corte de 21/10 (Araguaína, commit 13cfbaf9) FICA para quem só agradece, se
// despede, recusa ou diz um "vou ver e te aviso" sem motivo nem data: nesses, nada de horário empurrado.
// ---------------------------------------------------------------------------------------------------------------------

/** Recusa de verdade: não é adiamento, é "não". Nunca recebe proposta de horário. */
const RECUSOU = /n[ãa]o\s+(?:quero|tenho\s+interesse|me\s+interess|tenho\s+condi|vou\s+(?:fazer|querer|marcar)|pretendo)|j[áa]\s+(?:resolvi|me\s+resolvi|consegui\s+resolver|fechei|marquei\s+(?:em|com|outr))|fechei\s+com|desist|n[ãa]o\s+preciso|pare\s+de\s+me|me\s+tir[ae]\s+d[ao]/i;
/** O motivo ou o quando do adiamento, nas palavras reais dos pacientes (relatório de 27/11, L1-04 e vizinhas). */
const MOTIVO_DO_ADIAMENTO: RegExp[] = [
  // "vou falar/conversar/ver com meu marido/minha esposa/meu filho…"
  /\b(?:falar|conversar|ver|combinar|decidir|consultar)\b[^.!?\n]{0,25}\bcom\s+(?:(?:meu|minha|meus|minhas|o|a)\s+)?(?:marido|esposo|esposa|mulher|namorad[oa]|filh[oa]s?|m[ãa]e|pai|irm[ãa]o?|famil\w*|m[ée]dico|patr[ãa]o|chefe)/i,
  // dinheiro: "só recebo dia 8", "quando eu receber", "no dia do pagamento", "esse mês não dá"
  /\bs[óo]\s+recebo\b|\brecebo\s+(?:dia|s[óo]|no\s+dia|depois|em)\b|\bquando\s+(?:eu\s+)?(?:receber|pegar\s+o\s+sal[áa]rio)|\breceber\s+(?:o\s+)?(?:sal[áa]rio|pagamento|dinheiro)|\b(?:s[óo]|depois\s+d[oe]|at[ée]\s+o)\s+(?:meu\s+|o\s+)?sal[áa]rio|\bsal[áa]rio\s+(?:cair|sair|entrar)|\bdia\s+do\s+pagamento|\bfinal\s+do\s+m[êe]s|\bes(?:s|t)[ea]\s+m[êe]s\s+n[ãa]o\s+d[áa]/i,
  // data: "mês que vem", "semana que vem", "depois do dia 05", "depois do carnaval", "a partir do dia 10"
  /\bm[êe]s\s+que\s+vem|\bpr[óo]xim[oa]\s+(?:m[êe]s|semana)|\bsemana\s+que\s+vem|\bdepois\s+do\s+dia\s+\d|\bdepois\s+d[oae]s?\s+(?:feriado|carnaval|natal|ano\s+novo|f[ée]rias|viagem)|\ba\s+partir\s+d[eoa]\s+(?:dia\s+)?\d|\bs[óo]\s+(?:no\s+)?dia\s+\d/i,
  // viagem
  /\b(?:estou|t[oô]|to|vou\s+estar|vou)\s+(?:viajando|viajar)\b|\bde\s+viagem\b/i,
];

/**
 * O paciente ADIOU dizendo o motivo ou o quando? Só fala dele neste turno, sem pergunta (quem pergunta quer resposta, não proposta),
 * curta, e sem recusa. É isto — e não `pacienteEncerrou` — que a chave `adiamento-propoe-dia` usa para propor um dia em vez de calar.
 */
export function adiouComMotivo(falas: Fala[] | undefined): boolean {
  if (!falas) return false;
  const { textos } = turnoDoPaciente(falas);
  // "…, pode ser?" / "…, tá bom?" fecha o adiamento com uma perguntinha de cortesia: não é pergunta ao Sofia.
  const tudo = textos.join('\n').trim().replace(/[,;.\s]*(?:pode\s+ser|t[áa]\s+bom|tudo\s+bem|certo|beleza|combinado|ok)\s*\?+\s*$/i, '');
  if (!tudo || tudo.length > 300 || tudo.includes('?')) return false;
  if (RECUSOU.test(tudo)) return false;
  return MOTIVO_DO_ADIAMENTO.some((re) => re.test(tudo));
}

/**
 * O encerramento que vale para o CORTE de horário (graph.ts): o de sempre, exceto que — com a chave ligada — quem adiou com motivo NÃO é
 * "encerrou": a resposta pode (e deve) propor o dia e os dois horários, e a trava do horário inventado continua rodando neste turno.
 */
export function encerramentoParaCorte(falas: Fala[], propoeDia: boolean): Encerramento {
  if (propoeDia && adiouComMotivo(falas)) return null;
  return pacienteEncerrou(falas);
}

/** O bloco do turno quando ele adiou com motivo e a chave está ligada: propor o dia, não empurrar nem calar. */
export function renderPacienteAdiou(): string {
  return (
    '<paciente_adiou>\n(contado pelo sistema no histórico; vale mais que a regra da pergunta de continuidade e a de "sem horário")\n' +
    'Ele ADIOU dizendo o motivo ou o quando ("vou falar com meu marido", "só recebo dia 5", "estou viajando", "mês que vem"). ' +
    'Isto NÃO é despedida nem recusa: não feche com "te procuro depois", "fico no aguardo" ou "quando quiser me chama".\n' +
    '- Se ele JÁ TEM consulta marcada: responda curto, lembre o dia e a hora numa frase e NÃO proponha outro horário.\n' +
    '- Se ainda NÃO marcou: chame consultar_horarios para o primeiro dia útil EM ou DEPOIS do impedimento que ele disse (se ele só deu o motivo, ' +
    'sem data, o dia útil que vem daqui a 2 ou 3 dias) e, numa mensagem só, proponha UM dia com os DOIS horários que a agenda devolveu, ' +
    'retomando o motivo dele: "Combinado! Já deixo pra {dia}, depois que você {receber / falar com ele / voltar}? Tenho {h1} ou {h2}." ' +
    'Os dois horários vêm SÓ de consultar_horarios; nunca invente vaga. Se a agenda não devolver horário nesse dia, não ofereça nenhum: ' +
    '"combinado, te procuro no dia DD/MM".\n' +
    '- Só chame agendar_consulta se ele ESCOLHER um dos horários (a confirmação do dia segue valendo). NUNCA diga que está reservado, guardado ou ' +
    'garantido antes de marcar.\n' +
    '- Se ele recusar marcar agora ou preferir avisar depois: aceite sem insistir ("Combinado, te procuro no dia DD/MM"). Uma proposta só: ' +
    'não repita o horário na mensagem seguinte. Nunca prometa HORA de retorno.\n' +
    '</paciente_adiou>'
  );
}

/** As falas do paciente deste turno (as seguidas, depois da última fala da IA) e a fala da IA antes delas. */
function turnoDoPaciente(falas: Fala[]): { textos: string[]; ultimaIa: string | null } {
  let fim = falas.length - 1;
  while (fim >= 0 && falas[fim].papel !== 'paciente') fim--;
  const textos: string[] = [];
  let i = fim;
  for (; i >= 0 && falas[i].papel === 'paciente'; i--) textos.unshift(falas[i].texto);
  return { textos, ultimaIa: i >= 0 ? falas[i].texto : null };
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

/**
 * O bloco do turno. Vazio quando ele não encerrou.
 *
 * `perguntarMotivo` (chave `encerramento-pergunta-motivo`, pedido da Stefany, Timbó, 10/11/2026): "o paciente disse que
 * agora não pode e ela responde 'claro, sem pressa'… não, é pressa. Ela tem que perguntar: mas pra que eu entenda, o
 * que lhe fez esperar?". Ligada, quem adia ou encerra sem consulta recebe UMA pergunta sobre o motivo — nunca horário
 * (o corte de horário em graph.ts continua valendo). O "tá bom" depois da despedida da Sofia segue sem pergunta.
 */
export function renderPacienteEncerrou(falas: Fala[] | undefined, opcoes: { perguntarMotivo?: boolean; propoeDia?: boolean } = {}): string {
  // Chave `adiamento-propoe-dia`: adiou com motivo → propõe o dia e os dois horários, em vez do "NÃO ofereça horário" de quem encerrou.
  if (opcoes.propoeDia && adiouComMotivo(falas)) return renderPacienteAdiou();
  const enc = falas ? pacienteEncerrou(falas) : null;
  if (!enc) return '';
  if (opcoes.perguntarMotivo && enc !== 'concordou') {
    const oQue =
      enc === 'agradeceu'
        ? 'Ele agradeceu / se despediu nesta mensagem.'
        : 'Ele disse que agora não pode, que vai se organizar ou que avisa depois.';
    return (
      '<paciente_encerrou>\n(contado pelo sistema no histórico; vale mais que a regra da pergunta de continuidade)\n' +
      `${oQue}\n` +
      '- Se ele JÁ TEM consulta marcada: responda curto e caloroso, pode lembrar o dia e a hora numa frase, e NÃO pergunte nada.\n' +
      '- Se ainda NÃO marcou: NÃO feche com "sem pressa", "fico à disposição" ou "quando puder". Acolha numa frase e faça ' +
      'UMA pergunta curta e gentil para entender o que o faz esperar (ex.: "Claro! Só pra eu te ajudar melhor: o que ' +
      'te faz preferir esperar agora?"). Se ele já disse o motivo, responda ao motivo em uma frase.\n' +
      '- Se o motivo é com a equipe (valor, convênio, forma de pagamento, falar com alguém), ofereça chamar a equipe ' +
      'para conversar com ele por aqui.\n' +
      '- NÃO ofereça horário, NÃO pergunte "manhã ou tarde" e NÃO peça confirmação de vinda nesta mensagem.\n' +
      '</paciente_encerrou>'
    );
  }
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
