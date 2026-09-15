/**
 * "Esse paciente já tem consulta marcada?" — a pergunta que faltava antes de agendar.
 *
 * Caso Wilson (Rio Verde, 15/09/2026): ele tinha RETORNO marcado para 15/09 às 14h30
 * pela Kamila. Recebeu o template de véspera, respondeu "2e meia" — e a resposta caiu
 * num cartão NOVO, porque o telefone estava gravado com o nono dígito e o WhatsApp
 * entrega sem. A Sofia abriu ficha em branco, tratou um paciente de 12 dias como
 * desconhecido, viu as 14h30 "ocupadas" (por ele mesmo), ofereceu 15h, e terminou
 * remarcando o cara para quinta. Ele respondeu: "Imprevisto foi da parte de vcs não
 * minha". O RETORNO virou DESMARCADO e nasceu uma AVALIAÇÃO de R$ 350.
 *
 * `buscar_paciente` fazia o trabalho dela direito: achava o cadastro e confirmava pelo
 * telefone. O problema é o que ela dizia em seguida — "use este idClient em
 * agendar_consulta". Ela achava o paciente e empurrava para criar agendamento novo,
 * sem nunca olhar o que ele já tinha.
 *
 * FUSO: a franquia devolve `dateAttendance` em UTC de verdade (ancorado na conversa do
 * Wilson: ele combinou 16h, a API devolve 19:00Z). Renderizar aqui em hora local da
 * unidade — nunca em UTC, que foi como me enganei três vezes no mesmo dia.
 */

/** DESMARCADO (57) não conta: o horário foi devolvido à agenda. */
const DESMARCADO = 57;

/** Recorte do que `SpineService.getClient` devolve — mesmos nomes de campo. */
export interface AgendamentoDoPaciente {
  idSchedule: number | null;
  /** ISO da franquia; é UTC de verdade (ancorado na conversa do Wilson). */
  dateAttendanceUtc: string | null;
  categoryName: string | null;
  idStatus: number | null;
  statusName: string | null;
}

export interface ConsultaMarcada extends AgendamentoDoPaciente {
  quandoMs: number;
}

/** Só o que ainda vai acontecer e não foi desmarcado. Mais próxima primeiro. */
export function consultasFuturas(
  schedules: AgendamentoDoPaciente[] | null | undefined,
  agora: Date,
): ConsultaMarcada[] {
  const limite = agora.getTime();
  return (schedules ?? [])
    .filter((s) => s.dateAttendanceUtc && s.idStatus !== DESMARCADO)
    .map((s) => ({ ...s, quandoMs: Date.parse(String(s.dateAttendanceUtc)) }))
    .filter((s) => Number.isFinite(s.quandoMs) && s.quandoMs > limite)
    .sort((a, b) => a.quandoMs - b.quandoMs);
}

export function formatarQuando(quandoMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(quandoMs));
}

/**
 * O que a tool responde quando o paciente JÁ tem consulta. O texto manda confirmar ou
 * remarcar e proíbe agendar de novo — se ficasse só informando, o modelo seguiria o
 * caminho que já conhece, que é chamar `agendar_consulta`.
 */
export function avisoDeConsultaExistente(
  nome: string,
  idClient: number,
  consultas: ConsultaMarcada[],
  timeZone: string,
): string {
  const lista = consultas
    .map((c) => `• ${formatarQuando(c.quandoMs, timeZone)} — ${c.categoryName ?? 'consulta'} (${c.statusName ?? 'agendado'})`)
    .join('\n');
  const uma = consultas.length === 1;
  return (
    `PARE: ${nome} (idClient ${idClient}) JÁ TEM ${uma ? 'consulta marcada' : `${consultas.length} consultas marcadas`}:\n` +
    `${lista}\n\n` +
    'NÃO chame agendar_consulta — ele não é paciente novo. O que fazer:\n' +
    '• se ele está confirmando, confirme esse horário e encerre;\n' +
    '• se ele quer outro dia, use remarcar_consulta NO agendamento acima;\n' +
    '• se ele diz que o horário combinado é outro, NÃO discuta nem ofereça horário: ' +
    'passe para a equipe conferir.\n' +
    'Ao checar disponibilidade, lembre que o horário DELE aparece ocupado porque é dele — ' +
    'nunca diga ao paciente que o horário dele já foi tomado.'
  );
}
