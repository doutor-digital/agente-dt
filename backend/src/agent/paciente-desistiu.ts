/**
 * O paciente escreveu "cancelei", "pode desmarcar", "não vou poder ir" — e a Sofia TENTA REMARCAR.
 *
 * Decisão do João (26/10/2026), item 6 da lista da Suzanne: acolhe em uma frase e oferece novo horário (consultando a
 * agenda); se ele aceitar, marca no CRM.
 *
 * A SOFIA NÃO CANCELA NA FRANQUIA (decisão do coordenador após a reprovação do sênior no #132): cancelar é irreversível e o
 * classificador por frases ainda erra ("sim, cancela não", "sim, eu vou"). Recusa explícita → ela se despede SEM dizer que
 * cancelou ("vou avisar a equipe para cancelar") e o SISTEMA, em código (`lib/desistencia-acao.ts`), abre a tarefa urgente
 * "CANCELAR NA FRANQUIA" para o responsável do cartão e para a nossa véspera/régua. Na dúvida (manter, outra consulta,
 * hesitação) a Sofia responde normal e o sistema abre tarefa "conferir com o paciente", sem parar a véspera.
 *
 * O detector (`pareceDesistenciaDaConsulta`) mora em `lib/` porque a régua, o webhook e este bloco usam o mesmo.
 */
import {
  falouDeOutraConsulta,
  citouHorario,
  hesitou,
  negouAOferta,
  sinalDeQueVai,
  oferecuHorario,
  pareceDesistenciaDaConsulta,
  quisManter,
  recusouRemarcarExplicitamente,
} from '../lib/desistencia-frases.js';
import type { Fala } from './repeticao.js';
import { turnoDoPaciente } from './paciente-encerrou.js';

export type MomentoDaDesistencia =
  /** Acabou de avisar que não vem: a Sofia acolhe e OFERECE novo horário. */
  | 'avisou'
  /** Avisou, a Sofia ofereceu horário, e ele insiste em desistir ("pode cancelar mesmo"): é a recusa. */
  | 'insistiu'
  /** Avisou, a Sofia ofereceu horário, e esta é a resposta (que pode ser "não quero", "depois eu vejo", "sexta às 10h"). */
  | 'respondeu_a_oferta'
  /** Falou de OUTRA consulta ("cancela a do meu filho, a minha mantém"): a Sofia não cancela, a equipe confere. */
  | 'outra_consulta';

export interface DesistenciaDoTurno {
  momento: MomentoDaDesistencia;
  /** O trecho que disse que não vem (neste turno, ou no anterior quando ele está respondendo à oferta). */
  trecho: string;
  /** Neste turno ele RECUSOU remarcar de forma explícita ("pode cancelar mesmo", "não quero remarcar") — e não só hesitou. */
  recusaExplicita: boolean;
  /** Neste turno ele disse que quer MANTER a consulta ("não quero remarcar, quero manter", "cancela não", "vou sim"). */
  querManter?: boolean;
  /** O que ele escreveu neste turno (a resposta à oferta). */
  resposta?: string;
  /** Neste turno ele deu sinal de que VAI ("consegui folga", "vou na de amanhã mesmo"). */
  vai?: boolean;
  /** Neste turno ele disse "não" à oferta sem horário ("não, obrigado", "não precisa"). */
  negou?: boolean;
  /** Neste turno ele hesitou ("acho que não vou conseguir", "vou ver"). */
  hesitou?: boolean;
}

/** As falas seguidas da Sofia logo antes do turno (a oferta pode vir em DUAS mensagens) e o que o paciente disse antes delas. */
function oQueAntecede(falas: Fala[], inicio: number): { ia: string; pacienteAntes: string[] } {
  const ia: string[] = [];
  let i = inicio - 1;
  for (; i >= 0 && falas[i].papel === 'ia'; i--) ia.unshift(falas[i].texto);
  const pacienteAntes: string[] = [];
  for (; i >= 0 && falas[i].papel === 'paciente'; i--) pacienteAntes.unshift(falas[i].texto);
  return { ia: ia.join('\n'), pacienteAntes };
}

/**
 * Em que pé está a desistência — ou null. O que vale é o PAR de turnos: a fala do paciente antes das falas da Sofia (avisou,
 * e a oferta pode ter vindo em duas mensagens) e a que veio depois (a resposta). Sem isso o bloco sumia no turno seguinte,
 * justo quando a recusa chega ("não quero remarcar" não parece desistência).
 */
export function pacienteDesistiu(falas: Fala[]): DesistenciaDoTurno | null {
  const { textos, inicio } = turnoDoPaciente(falas);
  if (textos.length === 0) return null;
  const turno = textos.join('\n');
  const { ia, pacienteAntes } = oQueAntecede(falas, inicio);

  // consulta de outra pessoa, ou "deixa a de quinta": nunca cancela sozinha
  if (falouDeOutraConsulta(turno)) return { momento: 'outra_consulta', trecho: turno, recusaExplicita: false };

  const agora = textos.find((t) => pareceDesistenciaDaConsulta(t)) ?? null;
  const antes = ia && oferecuHorario(ia) ? (pacienteAntes.find((t) => pareceDesistenciaDaConsulta(t)) ?? null) : null;
  const querManter = textos.some((t) => quisManter(t));
  const hesitacao = textos.some((t) => hesitou(t));
  const vai = textos.some((t) => sinalDeQueVai(t));
  const negou = textos.some((t) => negouAOferta(t));
  const explicita = !querManter && textos.some((t) => recusouRemarcarExplicitamente(t));
  if (agora && antes) return { momento: 'insistiu', trecho: agora, recusaExplicita: explicita, querManter, hesitou: hesitacao, vai, negou, resposta: turno };
  if (agora) return { momento: 'avisou', trecho: agora, recusaExplicita: false, querManter };
  if (antes) return { momento: 'respondeu_a_oferta', trecho: antes, recusaExplicita: explicita, querManter, hesitou: hesitacao, vai, negou, resposta: turno };
  return null;
}

/** "não quero/vou/preciso remarcar": diz que NÃO quer remarcar. */
const NEGOU_REMARCAR = /\bn(ao|) (quero|vou|preciso|precisa|vamos) (mais )?(remarcar|reagendar|marcar|(de )?outro (dia|horario))/;
const normalizarSimples = (t: string | undefined): string => (t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export type AcaoDaDesistencia = 'nada' | 'oferta' | 'recusou' | 'duvida';

/**
 * O que o SISTEMA faz neste turno, além do que a Sofia escreve:
 *  - oferta: ela vai oferecer horário → marca, para a tarefa de "não respondeu";
 *  - recusou: recusa explícita de remarcar → tarefa urgente de cancelar na franquia + parar a nossa véspera/régua;
 *  - duvida: manter, outra consulta, hesitação, insistência sem recusa clara → tarefa "conferir com o paciente", sem parar nada;
 *  - nada: o resto (inclusive quem escolheu um horário da oferta ou só perguntou outra coisa).
 */
export function acaoDaDesistencia(d: DesistenciaDoTurno | null): AcaoDaDesistencia {
  if (!d) return 'nada';
  if (d.momento === 'avisou') return 'oferta';
  if (d.momento === 'outra_consulta') return 'duvida';
  if (d.recusaExplicita) return 'recusou';
  // escolheu horário ("pode ser quinta, se der", "sexta, vou sim"): a Sofia remarca, não é dúvida
  // escolheu horário ("pode ser quinta, se der", "sexta, vou sim"): a Sofia remarca, não é dúvida — a menos que diga que NÃO quer remarcar
  if (d.momento === 'respondeu_a_oferta' && citouHorario(d.resposta) && !NEGOU_REMARCAR.test(normalizarSimples(d.resposta))) return 'nada';
  if (d.momento === 'insistiu' || d.querManter || d.hesitou || d.vai || d.negou) return 'duvida';
  return 'nada';
}

/** Recusa explícita: despedida SEM dizer que cancelou; quem cancela é a equipe, avisada pelo sistema. */
const RECUSA_EXPLICITA_FECHO_LIGADO =
  'RECUSA EXPLÍCITA (só vale se ele TEM consulta marcada; sem consulta, trate como conversa normal): despeça-se com educação em 1 ou 2 frases ("fico à disposição, qualquer coisa é só me chamar"), SEM nova ' +
  'oferta. NÃO diga que a consulta foi cancelada — diga que vai avisar a equipe para cancelar ("vou avisar a equipe para cancelar ' +
  'e ela confirma com você"). NÃO chame cancelar_consulta e NÃO crie tarefa nem etiqueta: o sistema já avisou a equipe.';

/** Dúvida: responde normal, NÃO cancela, NÃO diz que cancelou. */
const DUVIDA_FECHO_LIGADO =
  'Se ele só HESITOU ("acho que não vou conseguir", "vou ver", "depois eu aviso"): em UMA frase, pergunte se prefere outro dia ' +
  '(e, se quiser, consulte horários) ou se não vai mesmo — sem cobrar. Se ele diz que quer MANTER ("quero manter", "vou sim", ' +
  '"cancela não"): confirme em UMA frase que a consulta segue marcada e NÃO ofereça outro horário. Em qualquer dúvida: NÃO diga ' +
  'que cancelou, NÃO chame cancelar_consulta e NÃO crie tarefa: o sistema avisa a equipe para conferir com ele.';

/**
 * A automação `desistencia-cancela` NÃO está "ligada" nesta unidade (nasce em "só no papel"): o sistema não avisa a equipe, então a
 * Sofia NÃO promete "vou avisar a equipe para cancelar". Só se despede e manda falar com a equipe da clínica.
 */
const RECUSA_EXPLICITA_FECHO_SEM_SISTEMA =
  'RECUSA EXPLÍCITA (só vale se ele TEM consulta marcada; sem consulta, trate como conversa normal): despeça-se com educação em 1 ou ' +
  '2 frases ("fico à disposição, qualquer coisa é só me chamar"), SEM nova oferta. NÃO diga que a consulta foi cancelada e NÃO ' +
  'prometa que a equipe vai cancelar: diga que, para cancelar, ele pode falar com a equipe da clínica. NÃO chame cancelar_consulta ' +
  'e NÃO crie tarefa nem etiqueta.';

const DUVIDA_FECHO_SEM_SISTEMA =
  'Se ele só HESITOU ("acho que não vou conseguir", "vou ver", "depois eu aviso"): em UMA frase, pergunte se prefere outro dia ' +
  '(e, se quiser, consulte horários) ou se não vai mesmo — sem cobrar. Se ele diz que quer MANTER ("quero manter", "vou sim", ' +
  '"cancela não"): confirme em UMA frase que a consulta segue marcada e NÃO ofereça outro horário. Em qualquer dúvida: NÃO diga ' +
  'que cancelou, NÃO chame cancelar_consulta e NÃO crie tarefa.';

/** O bloco do turno. Vazio quando não há desistência em andamento. */
/** `sistemaAvisa`: a automação `desistencia-cancela` está LIGADA na unidade (o sistema abre a tarefa e para a véspera). */
export function renderPacienteDesistiu(falas: Fala[] | undefined, opcoes: { slug?: string | null; sistemaAvisa?: boolean } = {}): string {
  const sistemaAvisa = opcoes.sistemaAvisa ?? false;
  const d = falas ? pacienteDesistiu(falas) : null;
  if (!d) return '';
  const dito = d.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  const abre = '<paciente_desistiu>\n(contado pelo sistema; vale mais que a regra de "pedido de CANCELAR" e que a de pergunta de continuidade)\n';
  const fim = '\n</paciente_desistiu>';
  const acao = acaoDaDesistencia(d);
  const fecho = acao === 'recusou' ? (sistemaAvisa ? RECUSA_EXPLICITA_FECHO_LIGADO : RECUSA_EXPLICITA_FECHO_SEM_SISTEMA) : sistemaAvisa ? DUVIDA_FECHO_LIGADO : DUVIDA_FECHO_SEM_SISTEMA;

  if (d.momento === 'outra_consulta') {
    return (
      abre +
      `Ele falou de OUTRA consulta, ou de manter uma e cancelar outra: "${dito}". NÃO chame cancelar_consulta e NÃO diga que cancelou: ` +
      'você não sabe qual ele quer. ' +
      (sistemaAvisa
        ? 'Diga em UMA frase que a equipe confere com ele qual consulta cancelar e qual manter. NÃO crie tarefa: o sistema já avisou a equipe.'
        : 'Diga em UMA frase que, para escolher qual cancelar e qual manter, ele pode falar com a equipe da clínica. NÃO crie tarefa.') + fim
    );
  }
  if (d.momento === 'insistiu') {
    return (
      abre +
      `Ele JÁ tinha avisado que não vem, você ofereceu outro horário, e agora escreve: "${dito}". NÃO ofereça os mesmos horários ` +
      `e NÃO pergunte "tem certeza?". Se ele só está pedindo outro dia, atenda com consultar_horarios + remarcar_consulta. ${fecho}` + fim
    );
  }
  if (d.momento === 'respondeu_a_oferta') {
    return (
      abre +
      `Ele avisou que não vem ("${dito}"), você ofereceu outro horário, e a mensagem de agora é a RESPOSTA dele à oferta.\n` +
      '- Se ele ESCOLHEU um horário: remarcar_consulta na consulta que ele já tem (nunca marque uma segunda) e só diga "remarcado" ' +
      'depois de a ferramenta confirmar.\n' +
      '- Se ele pediu outro dia ou outro período: consultar_horarios de novo e ofereça dois horários reais.\n' +
      (acao === 'recusou' || acao === 'duvida' ? `- ${fecho}\n` : '') +
      '- Se a mensagem é OUTRA coisa (uma pergunta, uma dúvida sobre valor ou endereço): responda a ela normalmente. NÃO cancele nada.' +
      fim
    );
  }
  return (
    abre +
    `Ele escreveu que não vem à consulta: "${dito}".\n` +
    'Decisão da casa: você TENTA REMARCAR. Só vale se ele TEM consulta marcada — confira (buscar_paciente / o cartão). Se não tem ' +
    '("cancelei o plano de saúde"), ignore este bloco.\n' +
    '1. Acolha em UMA frase curta, sem culpa e sem retenção. NÃO pergunte "tem certeza?", NÃO explique que a vaga volta para ' +
    'a fila, NÃO chame cancelar_consulta e NÃO diga que cancelou — mesmo que ele diga "pode cancelar": primeiro a oferta de novo horário.\n' +
    '2. Chame consultar_horarios e ofereça DOIS horários reais (dia da semana + DD/MM + hora), numa MESMA mensagem. Se ele já ' +
    'disse um dia ("semana que vem", "sexta"), consulte esse dia. Nunca ofereça horário de memória.\n' +
    '3. Se ele escolher um, use remarcar_consulta na consulta que ele já tem — nunca marque uma segunda — e só diga "remarcado" ' +
    'depois de a ferramenta confirmar.\n' +
    '4. Se ele recusar depois, o próximo bloco diz o que fazer.' +
    fim
  );
}
