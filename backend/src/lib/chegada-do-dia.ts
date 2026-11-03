/**
 * A CHEGADA DO PACIENTE NO DIA: o primeiro atendimento dele, somando todos os tratamentos e consultas.
 *
 * Por que isto existe (Açailândia, 03/11/2026): quem faz dois tratamentos ao mesmo tempo (cervical + lombar)
 * tem duas sessões em sequência — 15h30 e 16h. O cartão guarda um `⚙ idTreatment` só, e a resposta ao
 * "Confirmar presença" achava a sessão pelo tratamento do cartão: confirmava UMA só e dizia "16:00" (a do
 * tratamento do cartão). O paciente chegava às 16h e a primeira sessão, às 15h30, já tinha passado — atraso.
 * Caso medido: cartão 24830668, tratamentos 125336 e 125337, sessões nos mesmos dias 03/11, 06/11 e 09/11.
 *
 * Definições (decisão do João, 03/11/2026):
 *  - atendimento de pé = AGENDADO ou CONFIRMADO. DESMARCADO e REMARCADO ficam de fora: o horário voltou
 *    para a agenda, ou é registro de arrumação. (É a mesma lista que alimenta os contadores do cartão em
 *    `sessoes-para-cartao.ts`.)
 *  - chegada do dia = o primeiro atendimento de pé do paciente naquele dia, qualquer tratamento, avaliação
 *    ou retorno incluídos;
 *  - a mensagem diz TODOS os horários do dia e a chegada — dos que AINDA VÃO ACONTECER: quem toca o botão às
 *    15h45 não pode ouvir "chegue às 15h30", nem ter confirmada na franquia uma sessão que já passou.
 *
 * Tudo aqui é puro e trabalha com o que o chamador JÁ tem em mãos (a ficha do paciente, `GET /clients/{id}`):
 * nenhuma chamada nova à franquia.
 */
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { ehConsulta } from './franquia-sync.js';

export const STATUS_DE_PE: readonly number[] = [SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO];

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
function unicosDePe(schedules: readonly SpineSchedule[]): SpineSchedule[] {
  const vistos = new Set<number>();
  const out: SpineSchedule[] = [];
  for (const s of schedules) {
    if (!Number.isFinite(epochDoAtendimento(s))) continue;
    if (s.idStatus === null || s.idStatus === undefined || !STATUS_DE_PE.includes(s.idStatus)) continue;
    if (s.idSchedule != null) {
      if (vistos.has(s.idSchedule)) continue;
      vistos.add(s.idSchedule);
    }
    out.push(s);
  }
  return out.sort((a, b) => epochDoAtendimento(a) - epochDoAtendimento(b));
}

/**
 * Os atendimentos de pé do paciente num dia (AAAA-MM-DD, fuso da clínica), do primeiro ao último.
 * `aPartirDe` (epoch em segundos): só os que AINDA VÃO ACONTECER depois deste instante. O instante é absoluto,
 * então vale em qualquer fuso; sem ele, o dia inteiro.
 */
export function atendimentosDePeNoDia(schedules: readonly SpineSchedule[], dia: string, aPartirDe?: number): SpineSchedule[] {
  return unicosDePe(schedules).filter((s) => diaDoAtendimento(s) === dia && (aPartirDe === undefined || epochDoAtendimento(s) > aPartirDe));
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
 * Com `aPartirDe`, só entram os que ainda vão acontecer (ver `atendimentosDePeNoDia`).
 */
export interface DiaComVariosAtendimentos {
  dia: string;
  atendimentos: SpineSchedule[];
  horarios: string[];
  chegada: string;
}

export function diaComVariosAtendimentos(schedules: readonly SpineSchedule[], dia: string, aPartirDe?: number): DiaComVariosAtendimentos | null {
  const atendimentos = atendimentosDePeNoDia(schedules, dia, aPartirDe);
  const horarios = horariosDistintos(atendimentos);
  // 2+ agendamentos de pé já bastam para confirmar o dia inteiro; o TEXTO só muda quando os horários são 2+ (quem escreve confere).
  if (atendimentos.length < 2) return null;
  return { dia, atendimentos, horarios, chegada: horarios[0] };
}

/**
 * O dia separado pelo que o lembrete anunciou: `iguais` são do MESMO tipo do lembrete (sessão com sessão, consulta
 * com consulta) — esses o sistema confirma; `outros` são do outro tipo — esses a equipe confirma.
 */
export function gruposDoDia(v: Pick<DiaComVariosAtendimentos, 'atendimentos'>, tipo: 'sessao' | 'consulta'): { iguais: SpineSchedule[]; outros: SpineSchedule[] } {
  const iguais = v.atendimentos.filter((a) => ehConsulta(a) === (tipo === 'consulta'));
  return { iguais, outros: v.atendimentos.filter((a) => !iguais.includes(a)) };
}
