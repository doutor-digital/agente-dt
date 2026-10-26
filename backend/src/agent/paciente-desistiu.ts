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

export interface DesistenciaDoTurno {
  /** O trecho deste turno que disse que não vem. */
  trecho: string;
  /**
   * Já tinha avisado antes, a Sofia respondeu (a oferta de novo horário) e agora ele insiste: é a recusa. Não se oferece
   * horário de novo — o bloco manda despedir e abrir a tarefa. Olha só a fala do paciente logo antes da última da Sofia.
   */
  insistiu: boolean;
}

/** O que ele disse neste turno, ou null. */
export function pacienteDesistiu(falas: Fala[]): DesistenciaDoTurno | null {
  const { textos, ultimaIa } = turnoDoPaciente(falas);
  const trecho = textos.find((t) => pareceDesistenciaDaConsulta(t));
  if (!trecho) return null;
  let insistiu = false;
  if (ultimaIa !== null) {
    // `turnoDoPaciente` devolve as falas seguidas do paciente que terminam na última fala de paciente: acha onde começam
    let fim = falas.length - 1;
    while (fim >= 0 && falas[fim].papel !== 'paciente') fim--;
    const iaIdx = fim - textos.length; // a última fala da Sofia, logo antes do turno
    for (let j = iaIdx - 1; j >= 0 && falas[j].papel === 'paciente'; j--) {
      if (pareceDesistenciaDaConsulta(falas[j].texto)) insistiu = true;
    }
  }
  return { trecho, insistiu };
}

const FECHO_DA_RECUSA =
  'despeça-se com educação em 1 ou 2 frases ("fico à disposição, qualquer coisa é só me chamar"), SEM nova oferta e SEM ' +
  'insistir. Nesse caso, e só nele, chame criar_tarefa (texto: "Paciente desistiu da consulta de DD/MM e não quis remarcar: ' +
  'cancelar na franquia, pôr ✓ Situação da consulta = Desmarcado e tirar o cartão de AGENDADO") e aplicar_tag com ' +
  'NO_FOLLOW_UP — se essas ferramentas existirem para você. Não diga que a consulta foi cancelada: quem cancela na franquia é a equipe.';

/** O bloco do turno. Vazio quando ele não desistiu. */
export function renderPacienteDesistiu(falas: Fala[] | undefined): string {
  const d = falas ? pacienteDesistiu(falas) : null;
  if (!d) return '';
  const dito = d.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  const abre = '<paciente_desistiu>\n(contado pelo sistema; vale mais que a regra de "pedido de CANCELAR" e que a de pergunta de continuidade)\n';
  if (d.insistiu) {
    return (
      abre +
      `Ele JÁ tinha avisado que não vem, você já respondeu, e agora insiste: "${dito}". É a recusa — NÃO ofereça horário de novo ` +
      `e NÃO pergunte "tem certeza?". Se, ao contrário, ele só está pedindo outro dia, atenda com consultar_horarios + ` +
      `remarcar_consulta. Senão, ${FECHO_DA_RECUSA}\n` +
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
    `4. Se ele recusar, disser que não quer mais, ou que avisa depois: ${FECHO_DA_RECUSA}\n` +
    '</paciente_desistiu>'
  );
}
