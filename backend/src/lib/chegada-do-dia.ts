/**
 * A CHEGADA DO PACIENTE NO DIA: o primeiro atendimento dele, somando todos os tratamentos e consultas.
 *
 * Por que isto existe (Açailândia, 03/11/2026): quem faz dois tratamentos ao mesmo tempo (cervical + lombar)
 * tem duas sessões em sequência — 15h30 e 16h. O cartão guarda um `⚙ idTreatment` só, e a «◷ Próxima sessão»
 * era calculada só com as sessões DESSE tratamento. Resultado: o lembrete do robô e a resposta ao
 * "Confirmar presença" diziam "16:00" (a do tratamento do cartão), o paciente chegava às 16h e a primeira
 * sessão, às 15h30, já tinha passado — atraso, e a recepção desmarcando na mão. Caso medido: cartão 24830668,
 * tratamentos 125336 e 125337, sessões nos mesmos dias 03/11, 06/11 e 09/11.
 *
 * Definições (decisão do João, 03/11/2026):
 *  - atendimento de pé = AGENDADO ou CONFIRMADO. DESMARCADO e REMARCADO ficam de fora: o horário voltou
 *    para a agenda, ou é registro de arrumação. (É a mesma lista que alimenta os contadores do cartão em
 *    `sessoes-para-cartao.ts`; o `proxima-sessao.ts`, usado só no painel de estatística, ainda conta o 41.)
 *  - chegada do dia = o primeiro atendimento de pé do paciente naquele dia, qualquer tratamento, avaliação
 *    ou retorno incluídos;
 *  - a mensagem diz TODOS os horários do dia e a chegada.
 *
 * Tudo aqui é puro e trabalha com o que o chamador JÁ tem em mãos (a ficha do paciente, `GET /clients/{id}`,
 * que a varredura lê com cache de 1 h): nenhuma chamada nova à franquia.
 */
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { ehConsulta } from './franquia-sync.js';

export const STATUS_DE_PE: readonly number[] = [SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO];

/** O que já aconteceu hoje também conta como "o dia do paciente", só para achar a chegada (nunca para confirmar). */
const STATUS_DO_DIA: readonly number[] = [...STATUS_DE_PE, SPINE_STATUS.ATENDIDO];

export function epochDoAtendimento(s: Pick<SpineSchedule, 'dateAttendanceUtc'>): number {
  const ms = Date.parse(String(s.dateAttendanceUtc ?? ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

/** O dia no fuso da clínica (AAAA-MM-DD), como a franquia calcula. */
export function diaDoAtendimento(s: Pick<SpineSchedule, 'dayLocal' | 'dateAttendanceLocal'>): string | null {
  const d = s.dayLocal ?? (s.dateAttendanceLocal ? s.dateAttendanceLocal.slice(0, 10) : null);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** "HH:MM" local do atendimento. */
export function horaDoAtendimento(s: Pick<SpineSchedule, 'timeLocal' | 'dateAttendanceLocal'>): string | null {
  const h = s.timeLocal ?? (s.dateAttendanceLocal ? s.dateAttendanceLocal.slice(11, 16) : null);
  return h && /^\d{2}:\d{2}$/.test(h) ? h : null;
}

/** Tira o mesmo agendamento que veio da agenda E da ficha (mesmo idSchedule) e o que não tem data. Ordem por horário. */
function unicos(schedules: readonly SpineSchedule[], statusAceitos: readonly number[]): SpineSchedule[] {
  const vistos = new Set<number>();
  const out: SpineSchedule[] = [];
  for (const s of schedules) {
    if (!Number.isFinite(epochDoAtendimento(s))) continue;
    if (s.idStatus === null || s.idStatus === undefined || !statusAceitos.includes(s.idStatus)) continue;
    if (s.idSchedule != null) {
      if (vistos.has(s.idSchedule)) continue;
      vistos.add(s.idSchedule);
    }
    out.push(s);
  }
  return out.sort((a, b) => epochDoAtendimento(a) - epochDoAtendimento(b));
}

/** Os atendimentos de pé do paciente num dia (AAAA-MM-DD, fuso da clínica), do primeiro ao último. */
export function atendimentosDePeNoDia(schedules: readonly SpineSchedule[], dia: string): SpineSchedule[] {
  return unicos(schedules, STATUS_DE_PE).filter((s) => diaDoAtendimento(s) === dia);
}

/** Os horários DISTINTOS ("HH:MM") de uma lista de atendimentos, em ordem. Dois no mesmo horário contam uma vez. */
export function horariosDistintos(atendimentos: readonly SpineSchedule[]): string[] {
  const horas: string[] = [];
  for (const a of atendimentos) {
    const h = horaDoAtendimento(a);
    if (h && !horas.includes(h)) horas.push(h);
  }
  return horas;
}

/** "15:30" → "15h30"; "16:00" → "16h". Como a recepção escreve. */
export function horaFalada(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = String(Number(m[1]));
  return m[2] === '00' ? `${h}h` : `${h}h${m[2]}`;
}

/** ["15:30","16:00"] → "15h30 e 16h"; três → "15h30, 16h e 16h30". */
export function listaDeHorarios(horas: readonly string[]): string {
  const f = horas.map(horaFalada);
  if (f.length <= 1) return f.join('');
  return `${f.slice(0, -1).join(', ')} e ${f[f.length - 1]}`;
}

/**
 * O dia do paciente, quando ele tem MAIS de um agendamento de pé. null = um só (ou nenhum): nada muda.
 * `atendimentos` são todos, para confirmar; `horarios` são os horários DISTINTOS (dois agendamentos no mesmo
 * horário dão um horário só, e a mensagem continua a de sempre); `chegada` é o primeiro.
 */
export interface DiaComVariosAtendimentos {
  dia: string;
  atendimentos: SpineSchedule[];
  horarios: string[];
  chegada: string;
  /** só sessões, só consultas, ou os dois — muda a palavra da mensagem ("sessões" × "atendimentos"). */
  natureza: 'sessoes' | 'consultas' | 'misto';
}

export function diaComVariosAtendimentos(schedules: readonly SpineSchedule[], dia: string): DiaComVariosAtendimentos | null {
  const atendimentos = atendimentosDePeNoDia(schedules, dia);
  const horarios = horariosDistintos(atendimentos);
  // 2+ agendamentos de pé já bastam para confirmar o dia inteiro; o TEXTO só muda quando os horários são 2+ (quem escreve confere).
  if (atendimentos.length < 2) return null;
  const temConsulta = atendimentos.some((a) => ehConsulta(a));
  const temSessao = atendimentos.some((a) => !ehConsulta(a));
  return { dia, atendimentos, horarios, chegada: horarios[0], natureza: temConsulta && temSessao ? 'misto' : temConsulta ? 'consultas' : 'sessoes' };
}

/**
 * O valor da «◷ Próxima sessão» do cartão: a CHEGADA do próximo dia em que o paciente tem sessão.
 *
 *  - o dia é o da primeira SESSÃO de pé por vir (qualquer tratamento) — avaliação/retorno sozinhos não
 *    movem esse campo, que continua sendo o das sessões;
 *  - a chegada é o primeiro atendimento daquele dia (sessões e consultas de pé, e o que já foi atendido);
 *  - `jaComecou` = a chegada já passou (o paciente está na clínica, ou o 1º atendimento já foi dado e o
 *    2º ainda vem). Quem escreve NÃO mexe no campo nesse caso: trocar "15h30" por "16h" no meio da tarde
 *    faria o gatilho de lembrete do Kommo ler um valor novo e disparar de novo ou a destempo.
 *
 * null = nenhuma sessão de pé por vir (o campo deve ser limpo, como sempre foi).
 */
export interface ProximaChegada {
  epoch: number;
  dia: string;
  horarios: string[];
  jaComecou: boolean;
}

export function proximaChegada(schedules: readonly SpineSchedule[], agoraEpoch: number): ProximaChegada | null {
  const primeira = unicos(schedules, STATUS_DE_PE).find((s) => !ehConsulta(s) && epochDoAtendimento(s) > agoraEpoch);
  if (!primeira) return null;
  const dia = diaDoAtendimento(primeira);
  if (!dia) return null;
  const doDia = unicos(schedules, STATUS_DO_DIA).filter((s) => diaDoAtendimento(s) === dia);
  const epoch = Math.min(...doDia.map(epochDoAtendimento));
  return {
    epoch,
    dia,
    horarios: horariosDistintos(doDia.filter((s) => s.idStatus !== SPINE_STATUS.ATENDIDO)),
    jaComecou: epoch <= agoraEpoch,
  };
}

/**
 * Os agendamentos que são DESTE paciente, para calcular a chegada.
 *
 * A varredura agrupa a agenda por NOME (a agenda não traz idClient), então duas pacientes homônimas caem no mesmo
 * balaio — e a chegada de uma não pode virar o horário da outra. A fonte segura é a ficha (`GET /clients/{id}`,
 * por idClient). A agenda, mais fresca, só entra por cima dela: troca a versão de um agendamento que a ficha já
 * conhece, e acrescenta o que carrega o `idTreatment` de um tratamento DESTE paciente (sessão marcada na última
 * hora). Avaliação nova sem id de tratamento espera a ficha renovar (cache de 1 h).
 */
export function agendamentosDoPaciente(
  ficha: readonly SpineSchedule[],
  agenda: readonly SpineSchedule[],
  idsDeTratamento: readonly (number | null | undefined)[],
): SpineSchedule[] {
  const meus = new Set(idsDeTratamento.filter((n): n is number => typeof n === 'number'));
  const daAgenda = new Map<number, SpineSchedule>();
  for (const a of agenda) if (a.idSchedule != null) daAgenda.set(a.idSchedule, a);
  const idsDaFicha = new Set<number>();
  const out: SpineSchedule[] = [];
  for (const f of ficha) {
    if (f.idSchedule != null) idsDaFicha.add(f.idSchedule);
    out.push((f.idSchedule != null ? daAgenda.get(f.idSchedule) : undefined) ?? f);
  }
  for (const a of agenda) {
    if (a.idSchedule == null || idsDaFicha.has(a.idSchedule)) continue;
    if (a.idTreatment != null && meus.has(a.idTreatment)) out.push(a);
  }
  return out;
}
