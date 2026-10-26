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
import {
  falouDeOutraConsulta,
  oferecuHorario,
  pareceDesistenciaDaConsulta,
  perguntouConfirmarCancelamento,
  quisManter,
  recusouRemarcarExplicitamente,
  respostaDaConfirmacao,
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
  /** A Sofia perguntou "Confirmo o cancelamento da sua consulta de…?" e esta é a resposta. */
  | 'confirmando'
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
  /** Em `confirmando`: o que ele respondeu à pergunta. */
  resposta?: 'sim' | 'nao' | 'outra';
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

  // a Sofia perguntou "Confirmo o cancelamento…?": a resposta decide, e só um "sim" a ESSA pergunta cancela
  if (ia && perguntouConfirmarCancelamento(ia)) {
    return { momento: 'confirmando', trecho: turno, recusaExplicita: false, resposta: respostaDaConfirmacao(turno) };
  }
  // consulta de outra pessoa, ou "deixa a de quinta": nunca cancela sozinha
  if (falouDeOutraConsulta(turno)) return { momento: 'outra_consulta', trecho: turno, recusaExplicita: false };

  const agora = textos.find((t) => pareceDesistenciaDaConsulta(t)) ?? null;
  const antes = ia && oferecuHorario(ia) ? (pacienteAntes.find((t) => pareceDesistenciaDaConsulta(t)) ?? null) : null;
  const querManter = textos.some((t) => quisManter(t));
  const explicita = !querManter && textos.some((t) => recusouRemarcarExplicitamente(t));
  if (agora && antes) return { momento: 'insistiu', trecho: agora, recusaExplicita: explicita, querManter };
  if (agora) return { momento: 'avisou', trecho: agora, recusaExplicita: false, querManter };
  if (antes) return { momento: 'respondeu_a_oferta', trecho: antes, recusaExplicita: explicita, querManter };
  return null;
}

const TAREFA = (slug: string | null | undefined, o: string) =>
  `criar_tarefa com este texto — começando exatamente por "ALERTA ·", que é o que faz o aviso chegar ao grupo: ` +
  `"ALERTA · ${slug || '(unidade)'} · [Contato: primeiro nome] ${o}"`;

/** A consulta só cai depois de a Sofia NOMEAR qual e de um "sim" a essa pergunta. */
const perguntaDeConfirmacao = (slug: string | null | undefined): string =>
  'RECUSA EXPLÍCITA, mas ainda NÃO cancele: chame cancelar_consulta SEM confirmado (ela devolve a consulta dele, com dia e hora) ' +
  'e pergunte EXATAMENTE: "Confirmo o cancelamento da sua consulta de <dia, DD/MM às HH:mm>?". Só chame ' +
  'cancelar_consulta(confirmado=true) na PRÓXIMA mensagem, e só se ele responder "sim" a ESSA pergunta. Se a ferramenta disser ' +
  'que não há consulta marcada por aqui, que a consulta já passou/foi atendida, ou que não conseguiu confirmar na clínica: NÃO ' +
  'diga que cancelou; diga que a equipe confirma, despeça-se, e chame ' +
  TAREFA(slug, 'Desistiu da consulta de DD/MM: conferir na franquia e cancelar se for o caso') +
  ' e aplicar_tag NO_FOLLOW_UP.';

/** Hesitação ("acho que não vou conseguir", "vou ver", só agradeceu): NÃO cancela — oferece remarcar. */
const OFERECE_DE_NOVO =
  'Se ele só HESITOU ("acho que não vou conseguir", "vou ver", "depois eu aviso") ou só agradeceu: NÃO cancele a consulta. ' +
  'Em UMA frase, pergunte se prefere outro dia (e, se quiser, consulte horários) ou se quer mesmo cancelar — sem cobrar.';

const MANTER =
  'Se ele diz que quer MANTER a consulta ("quero manter", "vou sim", "cancela não", "consegui me organizar"): NÃO cancele e NÃO ' +
  'ofereça outro horário. Em UMA frase, confirme que a consulta segue marcada (cite dia e hora só se souber pela ferramenta ' +
  'ou pelo cartão).';

/** Depois do "sim": cancelar_consulta(confirmado=true) e o desfecho. */
function cancelaOuTarefa(slug: string | null | undefined): string {
  return (
    'Ele disse "sim" à pergunta de confirmação: chame cancelar_consulta com confirmado=true. ' +
    '(a) Se a ferramenta confirmar: diga em UMA frase que a consulta foi cancelada, despeça-se com educação ' +
    '("fico à disposição, qualquer coisa é só me chamar"), e aplique aplicar_tag NO_FOLLOW_UP. NÃO ofereça outro horário — ' +
    'isso já foi feito. ' +
    '(b) Se ela disser que não há consulta marcada por aqui, que a consulta já passou/foi atendida, que não conseguiu confirmar na ' +
    'clínica ou devolver erro: NÃO diga que cancelou; diga que a equipe confirma, despeça-se, e chame ' +
    TAREFA(slug, 'Desistiu da consulta de DD/MM: cancelar na franquia, pôr ✓ Situação da consulta = Desmarcado e tirar o cartão de AGENDADO') +
    ' e aplicar_tag NO_FOLLOW_UP. (Se essas ferramentas não existirem para você, só a despedida.)'
  );
}

/** O bloco do turno. Vazio quando não há desistência em andamento. */
export function renderPacienteDesistiu(falas: Fala[] | undefined, opcoes: { slug?: string | null } = {}): string {
  const d = falas ? pacienteDesistiu(falas) : null;
  if (!d) return '';
  const dito = d.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  const abre = '<paciente_desistiu>\n(contado pelo sistema; vale mais que a regra de "pedido de CANCELAR" e que a de pergunta de continuidade)\n';
  const fim = '\n</paciente_desistiu>';
  const slug = opcoes.slug;

  if (d.momento === 'outra_consulta') {
    return (
      abre +
      `Ele falou de OUTRA consulta, ou de manter uma e cancelar outra: "${dito}". NÃO chame cancelar_consulta: ela cancela a ` +
      'consulta deste cartão, e você não sabe qual ele quer. Diga em UMA frase que a equipe confere qual consulta cancelar e ' +
      'chame ' + TAREFA(slug, 'Pediu para cancelar OUTRA consulta ("trecho da mensagem"): conferir qual cancelar e qual manter') + '.' + fim
    );
  }
  if (d.momento === 'confirmando') {
    const r = d.resposta;
    return (
      abre +
      `Você perguntou "Confirmo o cancelamento da sua consulta de…?" e a resposta dele é: "${dito}".\n` +
      (r === 'sim'
        ? cancelaOuTarefa(slug)
        : r === 'nao'
          ? 'Ele NÃO confirmou (disse não, ou quer manter): NÃO cancele. Diga em UMA frase que a consulta segue marcada e que ele pode chamar se mudar de ideia.'
          : 'A resposta NÃO é um "sim" claro: NÃO cancele. Responda o que ele perguntou, se houver, e repita a pergunta de confirmação com a consulta nomeada.') +
      fim
    );
  }
  if (d.momento === 'insistiu') {
    return (
      abre +
      `Ele JÁ tinha avisado que não vem, você ofereceu outro horário, e agora escreve: "${dito}". NÃO ofereça os mesmos ` +
      `horários e NÃO pergunte "tem certeza?". Se ele só está pedindo outro dia, atenda com consultar_horarios + remarcar_consulta. ` +
      `${MANTER} Senão: ${d.recusaExplicita ? perguntaDeConfirmacao(slug) : OFERECE_DE_NOVO}` + fim
    );
  }
  if (d.momento === 'respondeu_a_oferta') {
    return (
      abre +
      `Ele avisou que não vem ("${dito}"), você ofereceu outro horário, e a mensagem de agora é a RESPOSTA dele à oferta.\n` +
      '- Se ele ESCOLHEU um horário: remarcar_consulta na consulta que ele já tem (nunca marque uma segunda) e só diga "remarcado" ' +
      'depois de a ferramenta confirmar.\n' +
      '- Se ele pediu outro dia ou outro período: consultar_horarios de novo e ofereça dois horários reais.\n' +
      `- ${MANTER}\n` +
      `- Senão: ${d.recusaExplicita ? perguntaDeConfirmacao(slug) : OFERECE_DE_NOVO}\n` +
      '- Se a mensagem é OUTRA coisa (uma pergunta, uma dúvida sobre valor ou endereço): responda a ela normalmente e NÃO use o fecho.' +
      fim
    );
  }
  return (
    abre +
    `Ele escreveu que não vem à consulta: "${dito}".\n` +
    'Decisão da casa: você TENTA REMARCAR antes de aceitar o cancelamento. Só vale se ele TEM consulta marcada — confira ' +
    '(buscar_paciente / o cartão). Se não tem ("cancelei o plano de saúde"), ignore este bloco.\n' +
    '1. Acolha em UMA frase curta, sem culpa e sem retenção. NÃO pergunte "tem certeza?", NÃO explique que a vaga volta para ' +
    'a fila e NÃO chame cancelar_consulta agora — mesmo que ele diga "pode cancelar": primeiro a oferta de novo horário.\n' +
    '2. Chame consultar_horarios e ofereça DOIS horários reais (dia da semana + DD/MM + hora), numa MESMA mensagem. Se ele já ' +
    'disse um dia ("semana que vem", "sexta"), consulte esse dia. Nunca ofereça horário de memória.\n' +
    '3. Se ele escolher um, use remarcar_consulta na consulta que ele já tem — nunca marque uma segunda — e só diga "remarcado" ' +
    'depois de a ferramenta confirmar.\n' +
    '4. Se ele responder depois recusando, o próximo bloco diz o que fazer; não cancele antes disso.' +
    fim
  );
}
