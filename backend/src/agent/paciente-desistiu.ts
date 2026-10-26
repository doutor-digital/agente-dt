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
import { pareceDesistenciaDaConsulta } from '../lib/desistencia-da-consulta.js';
import type { Fala } from './repeticao.js';
import { turnoDoPaciente } from './paciente-encerrou.js';

/** O trecho que disse que não vem, ou null. */
export function pacienteDesistiu(falas: Fala[]): string | null {
  const { textos } = turnoDoPaciente(falas);
  return textos.find((t) => pareceDesistenciaDaConsulta(t)) ?? null;
}

/** O bloco do turno. Vazio quando ele não desistiu. */
export function renderPacienteDesistiu(falas: Fala[] | undefined): string {
  const trecho = falas ? pacienteDesistiu(falas) : null;
  if (!trecho) return '';
  const dito = trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  return (
    '<paciente_desistiu>\n(contado pelo sistema; vale mais que a regra de "pedido de CANCELAR" e que a de pergunta de continuidade)\n' +
    `Ele escreveu que não vem à consulta: "${dito}".\n` +
    'Decisão da casa: você TENTA REMARCAR antes de aceitar o cancelamento. Só vale se ele TEM consulta marcada — confira ' +
    '(buscar_paciente / o cartão). Se não tem ("cancelei o plano de saúde"), ignore este bloco.\n' +
    '1. Acolha em UMA frase curta, sem culpa e sem retenção. NÃO pergunte "tem certeza?", NÃO explique que a vaga volta para ' +
    'a fila e NÃO chame cancelar_consulta agora.\n' +
    '2. Chame consultar_horarios e ofereça DOIS horários reais (dia da semana + DD/MM + hora). Se ele já disse um dia ("semana ' +
    'que vem", "sexta"), consulte esse dia. Nunca ofereça horário de memória.\n' +
    '3. Se ele escolher um, use remarcar_consulta na consulta que ele já tem — nunca marque uma segunda — e só diga "remarcado" ' +
    'depois de a ferramenta confirmar.\n' +
    '4. Se ele recusar, disser que não quer mais, ou que avisa depois: despeça-se com educação em 1 ou 2 frases ("fico à ' +
    'disposição, qualquer coisa é só me chamar"), SEM nova oferta e SEM insistir. Nesse caso, e só nele, chame criar_tarefa ' +
    '(texto: "Paciente desistiu da consulta de DD/MM e não quis remarcar: cancelar na franquia, pôr ✓ Situação da consulta = ' +
    'Desmarcado e tirar o cartão de AGENDADO") e aplicar_tag com NO_FOLLOW_UP — se essas ferramentas existirem para você.\n' +
    '5. Não diga que a consulta foi cancelada: quem cancela na franquia é a equipe.\n' +
    '</paciente_desistiu>'
  );
}
