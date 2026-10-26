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
import { pareceDesistenciaDaConsulta, recusouRemarcarExplicitamente } from '../lib/desistencia-frases.js';
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
  /** Neste turno ele RECUSOU remarcar de forma explícita ("pode cancelar mesmo", "não quero remarcar") — e não só hesitou. */
  recusaExplicita: boolean;
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
  const explicita = textos.some((t) => recusouRemarcarExplicitamente(t));
  if (agora && antes) return { momento: 'insistiu', trecho: agora, recusaExplicita: explicita };
  if (agora) return { momento: 'avisou', trecho: agora, recusaExplicita: false };
  if (antes) return { momento: 'respondeu_a_oferta', trecho: antes, recusaExplicita: explicita };
  return null;
}

const TAREFA = (slug: string | null | undefined) =>
  `criar_tarefa com este texto — começando exatamente por "ALERTA ·", que é o que faz o aviso chegar ao grupo: ` +
  `"ALERTA · ${slug || '(unidade)'} · [Contato: primeiro nome] Desistiu da consulta de DD/MM: cancelar na franquia, pôr ✓ Situação da ` +
  'consulta = Desmarcado e tirar o cartão de AGENDADO"';

/**
 * A recusa EXPLÍCITA de remarcar: a Sofia CANCELA na franquia (cancelar_consulta, confirmado=true — a recusa já é a
 * confirmação) para o franquia-sync gravar Situação = Desmarcado e os lembretes pararem. Sem consulta no vínculo, sem
 * confirmação da clínica ou com erro, a ferramenta diz — e aí é tarefa para a equipe cancelar. Decisão de 26/10/2026.
 */
function cancelaOuTarefa(slug: string | null | undefined): string {
  return (
    'RECUSA EXPLÍCITA: chame cancelar_consulta com confirmado=true (a recusa dele já é a confirmação — NÃO pergunte de novo). ' +
    '(a) Se a ferramenta confirmar o cancelamento: diga em UMA frase que a consulta foi cancelada, despeça-se com educação ' +
    '("fico à disposição, qualquer coisa é só me chamar"), SEM nova oferta, e aplique aplicar_tag NO_FOLLOW_UP. ' +
    '(b) Se ela disser que não há consulta marcada por aqui, que não conseguiu confirmar na clínica ou devolver erro: NÃO diga ' +
    'que cancelou; diga que a equipe confirma o cancelamento, despeça-se, e chame ' + TAREFA(slug) + ' e aplicar_tag NO_FOLLOW_UP. ' +
    '(Se essas ferramentas não existirem para você, só a despedida.)'
  );
}

/** Hesitação ("acho que não vou conseguir", "vou ver", só agradeceu): NÃO cancela — oferece remarcar. */
const OFERECE_DE_NOVO =
  'Se ele só HESITOU ("acho que não vou conseguir", "vou ver", "depois eu aviso") ou só agradeceu: NÃO cancele a consulta. ' +
  'Em UMA frase, pergunte se prefere outro dia (e, se quiser, consulte horários) ou se quer mesmo cancelar — sem cobrar.';

/** O bloco do turno. Vazio quando não há desistência em andamento. */
export function renderPacienteDesistiu(falas: Fala[] | undefined, opcoes: { slug?: string | null } = {}): string {
  const d = falas ? pacienteDesistiu(falas) : null;
  if (!d) return '';
  const dito = d.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  const abre = '<paciente_desistiu>\n(contado pelo sistema; vale mais que a regra de "pedido de CANCELAR" e que a de pergunta de continuidade)\n';
  const fecho = d.recusaExplicita ? cancelaOuTarefa(opcoes.slug) : OFERECE_DE_NOVO;
  if (d.momento === 'insistiu') {
    return (
      abre +
      `Ele JÁ tinha avisado que não vem, você ofereceu outro horário, e agora insiste: "${dito}". NÃO ofereça os mesmos horários ` +
      `e NÃO pergunte "tem certeza?". Se ele só está pedindo outro dia, atenda com consultar_horarios + remarcar_consulta. ` +
      `Senão: ${fecho}\n` +
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
      `- Senão: ${fecho}\n` +
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
    'a fila e NÃO chame cancelar_consulta agora — mesmo que ele diga "pode cancelar": primeiro a oferta de novo horário.\n' +
    '2. Chame consultar_horarios e ofereça DOIS horários reais (dia da semana + DD/MM + hora). Se ele já disse um dia ("semana ' +
    'que vem", "sexta"), consulte esse dia. Nunca ofereça horário de memória.\n' +
    '3. Se ele escolher um, use remarcar_consulta na consulta que ele já tem — nunca marque uma segunda — e só diga "remarcado" ' +
    'depois de a ferramenta confirmar.\n' +
    '4. Se ele responder depois recusando, o próximo bloco diz o que fazer; não cancele antes disso.\n' +
    '</paciente_desistiu>'
  );
}
