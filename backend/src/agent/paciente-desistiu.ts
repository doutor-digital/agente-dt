/**
 * O paciente escreveu "cancelei", "pode desmarcar", "não vou poder ir" — e a Sofia TENTA REMARCAR.
 *
 * Decisão do João (26/10/2026), item 6 da lista da Suzanne: acolhe em uma frase e oferece novo horário (consultando a
 * agenda); se ele aceitar, marca no CRM; se recusar ou não responder, encerra com educação, para a régua e abre tarefa
 * para a equipe.
 *
 * Antes disto o prompt mandava, para "pedido de cancelar", seguir o fluxo de cancelamento — que PERGUNTA "tem certeza?"
 * (cancelar_consulta sem `confirmado`) — e só DEPOIS de cancelado perguntar se quer remarcar. Para quem já disse que
 * cancelou, a pergunta de retenção é atrito; e o horário novo vinha tarde demais.
 *
 * O detector (`pareceDesistenciaDaConsulta`) mora em `lib/` porque a régua, o webhook e este bloco usam o mesmo — uma
 * frase que cala a régua tem de ser a mesma que faz a Sofia oferecer horário.
 *
 * Só a fala deste turno (as seguidas, depois da última da IA). Sem consulta marcada ("cancelei o plano de saúde") o
 * bloco manda ignorar: quem sabe se ele tem consulta é a ferramenta, não o regex.
 */
import { pareceDesistenciaDaConsulta } from '../lib/desistencia-frases.js';
import type { Fala } from './repeticao.js';
import { turnoDoPaciente } from './paciente-encerrou.js';

export type MomentoDaDesistencia =
  /** Acabou de avisar que não vem: a Sofia acolhe e OFERECE novo horário. */
  | 'avisou'
  /** Avisou, a Sofia ofereceu horário, e ele insiste em desistir ("pode cancelar mesmo"): é a recusa. */
  | 'insistiu'
  /** Avisou, a Sofia ofereceu horário, e esta é a resposta (que pode ser "não quero", "depois eu vejo", "sexta às 10h"). */
  | 'respondeu_a_oferta';

export interface DesistenciaDoTurno {
  momento: MomentoDaDesistencia;
  /** O trecho que disse que não vem (neste turno, ou no anterior quando ele está respondendo à oferta). */
  trecho: string;
}

/**
 * A Sofia propôs horário nesta fala? Relógio ("14h", "14h30", "14:30", "9 horas") MAIS um dia ("sexta", "amanhã", "27/10"):
 * "nosso horário de atendimento é das 8h às 18h" tem relógio e não é oferta.
 */
const RELOGIO = /\b\d{1,2}\s*(?:h(?:\d{2})?\b|:\d{2}|horas?\b)/i;
const DIA = /\b(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|amanh[ãa]|hoje)\b|\b\d{1,2}\/\d{1,2}\b/i;
const oferecuHorario = (fala: string): boolean => RELOGIO.test(fala) && DIA.test(fala);

/**
 * Em que pé está a desistência — ou null. O que vale é o PAR de turnos: a fala do paciente logo antes da última da Sofia
 * (avisou) e a que veio depois (a resposta). Sem isso o bloco sumia no turno seguinte, justo quando a recusa chega ("não
 * quero remarcar" não parece desistência), e o fecho — tarefa, NO_FOLLOW_UP, despedida — nunca era mandado.
 */
export function pacienteDesistiu(falas: Fala[]): DesistenciaDoTurno | null {
  const { textos, ultimaIa, inicio } = turnoDoPaciente(falas);
  const agora = textos.find((t) => pareceDesistenciaDaConsulta(t)) ?? null;
  // o que ele disse logo antes da fala da Sofia, e só se a fala dela foi mesmo a oferta de horário
  let antes: string | null = null;
  if (ultimaIa !== null && oferecuHorario(ultimaIa)) {
    for (let j = inicio - 2; j >= 0 && falas[j].papel === 'paciente'; j--) {
      if (pareceDesistenciaDaConsulta(falas[j].texto)) antes = falas[j].texto;
    }
  }
  if (agora && antes) return { momento: 'insistiu', trecho: agora };
  if (agora) return { momento: 'avisou', trecho: agora };
  if (antes) return { momento: 'respondeu_a_oferta', trecho: antes };
  return null;
}

/** O fecho: despedida, tarefa que chega no WhatsApp do grupo (prefixo ALERTA) e NO_FOLLOW_UP para os robôs do Kommo. */
function fechoDaRecusa(slug: string | null | undefined): string {
  return (
    'despeça-se com educação em 1 ou 2 frases ("fico à disposição, qualquer coisa é só me chamar"), SEM nova oferta e SEM ' +
    'insistir. Nesse caso, e só nele, chame criar_tarefa com este texto — começando exatamente por "ALERTA ·", que é o que ' +
    `faz o aviso chegar ao grupo: "ALERTA · ${slug || '(unidade)'} · [Contato: primeiro nome] Desistiu da consulta de DD/MM e não ` +
    'quis remarcar: cancelar na franquia, pôr ✓ Situação da consulta = Desmarcado e tirar o cartão de AGENDADO" — e ' +
    'aplicar_tag com NO_FOLLOW_UP, se essas ferramentas existirem para você. Não diga que a consulta foi cancelada: quem ' +
    'cancela na franquia é a equipe.'
  );
}

/** O bloco do turno. Vazio quando não há desistência em andamento. */
export function renderPacienteDesistiu(falas: Fala[] | undefined, opcoes: { slug?: string | null } = {}): string {
  const d = falas ? pacienteDesistiu(falas) : null;
  if (!d) return '';
  const dito = d.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  const abre = '<paciente_desistiu>\n(contado pelo sistema; vale mais que a regra de "pedido de CANCELAR" e que a de pergunta de continuidade)\n';
  const fecho = fechoDaRecusa(opcoes.slug);
  if (d.momento === 'insistiu') {
    return (
      abre +
      `Ele JÁ tinha avisado que não vem, você ofereceu outro horário, e agora insiste: "${dito}". É a recusa — NÃO ofereça horário de novo ` +
      `e NÃO pergunte "tem certeza?". Se, ao contrário, ele só está pedindo outro dia, atenda com consultar_horarios + ` +
      `remarcar_consulta. Senão, ${fecho}\n` +
      '</paciente_desistiu>'
    );
  }
  if (d.momento === 'respondeu_a_oferta') {
    return (
      abre +
      `Ele avisou que não vem ("${dito}"), você ofereceu outro horário, e a mensagem de agora é a RESPOSTA dele à oferta.\n` +
      '- Se ele ESCOLHEU um horário: remarcar_consulta na consulta que ele já tem (nunca marque uma segunda) e só diga "remarcado" ' +
      'depois de a ferramenta confirmar.\n' +
      '- Se ele pediu outro dia ou outro período: consultar_horarios de novo e ofereça dois horários reais.\n' +
      `- Se ele recusou, disse que não quer, que vai ver depois ou só agradeceu: ${fecho}\n` +
      '- Se a mensagem é OUTRA coisa (uma pergunta, uma dúvida sobre valor ou endereço): responda a ela normalmente e NÃO use o fecho.\n' +
      '</paciente_desistiu>'
    );
  }
  return (
    abre +
    `Ele escreveu que não vem à consulta: "${dito}".\n` +
    'Decisão da casa: você TENTA REMARCAR antes de aceitar o cancelamento. Só vale se ele TEM consulta marcada — confira ' +
    '(buscar_paciente / o cartão). Se não tem ("cancelei o plano de saúde"), ignore este bloco.\n' +
    '1. Acolha em UMA frase curta, sem culpa e sem retenção. NÃO pergunte "tem certeza?", NÃO explique que a vaga volta para ' +
    'a fila e NÃO chame cancelar_consulta agora.\n' +
    '2. Chame consultar_horarios e ofereça DOIS horários reais (dia da semana + DD/MM + hora). Se ele já disse um dia ("semana ' +
    'que vem", "sexta"), consulte esse dia. Nunca ofereça horário de memória.\n' +
    '3. Se ele escolher um, use remarcar_consulta na consulta que ele já tem — nunca marque uma segunda — e só diga "remarcado" ' +
    'depois de a ferramenta confirmar.\n' +
    `4. Se ele recusar, disser que não quer mais, ou que avisa depois: ${fecho}\n` +
    '</paciente_desistiu>'
  );
}
