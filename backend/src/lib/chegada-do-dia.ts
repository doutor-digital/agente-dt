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

/** Tira o mesmo agendamento que veio da agenda E da ficha (mesmo idSchedule), o que não tem data e o de status fora da lista. Ordem por horário. */
function unicosComStatus(schedules: readonly SpineSchedule[], statusAceitos: readonly number[]): SpineSchedule[] {
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
  return out.sort((x, y) => epochDoAtendimento(x) - epochDoAtendimento(y));
}
const unicosDePe = (schedules: readonly SpineSchedule[]) => unicosComStatus(schedules, STATUS_DE_PE);

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

// ── a ◷ Próxima sessão do cartão ─────────────────────────────────────────────────────────────────

/** Dois atendimentos do mesmo dia "em sequência": o seguinte começa até 2 h depois do anterior. */
export const SEQUENCIA_MAX_S = 2 * 3600;

/** O que já foi atendido hoje também conta como "o dia do paciente", só para achar a chegada (nunca para confirmar). */
const STATUS_DO_DIA: readonly number[] = [...STATUS_DE_PE, SPINE_STATUS.ATENDIDO];

/**
 * O valor da «◷ Próxima sessão» do cartão: a CHEGADA da viagem em que está a próxima sessão do tratamento DO CARTÃO.
 *
 *  - ANCORADO no tratamento do cartão: `ancoraEpoch` é a próxima sessão por vir dele (quem chama já a calculou). O dia é o dela.
 *    Um cartão cujo tratamento acabou (ALTA, FINALIZADO) não tem âncora, e quem chama LIMPA o campo como sempre fez — ainda que o
 *    paciente tenha sessão de OUTRO tratamento (aquele tem o cartão dele);
 *  - só SESSÕES entram. Avaliação e retorno têm a «◷ Data da Consulta» e os lembretes próprios; pôr o horário de uma consulta no
 *    campo da sessão faria o lembrete de sessão anunciar um horário que a resposta ao botão não acha ("sessão às 08:00");
 *  - a chegada é a primeira sessão da SEQUÊNCIA que termina na âncora (cada uma começa até 2 h depois da anterior), de qualquer
 *    tratamento, atendida ou de pé. Uma sessão de manhã e outra à noite não são a mesma viagem.
 *
 * `jaComecou` = a chegada já passou. Quem escreve NÃO mexe no campo nesse caso: trocar "15h30" por "16h" no meio da tarde faria o
 * gatilho de lembrete do Kommo ler um valor novo e disparar de novo ou a destempo.
 *
 * null = a âncora não está na lista do paciente (ficha em cache): quem chama volta ao valor de sempre, o do tratamento.
 */
export interface ChegadaDoCartao {
  epoch: number;
  dia: string;
  jaComecou: boolean;
}

export function chegadaDoCartao(schedules: readonly SpineSchedule[], ancoraEpoch: number, agoraEpoch: number): ChegadaDoCartao | null {
  // além dos de pé, os já ATENDIDOS contam como "o dia do paciente", só para achar onde a viagem começou (nunca para confirmar)
  const sessoes = unicosComStatus(schedules, STATUS_DO_DIA);
  const ancora = sessoes.find((s) => !ehConsulta(s) && epochDoAtendimento(s) === ancoraEpoch && STATUS_DE_PE.includes(s.idStatus as number));
  const dia = ancora ? diaDoAtendimento(ancora) : null;
  if (!ancora || !dia) return null;
  const doDia = sessoes.filter((s) => !ehConsulta(s) && diaDoAtendimento(s) === dia && epochDoAtendimento(s) <= ancoraEpoch);
  let epoch = ancoraEpoch;
  for (let i = doDia.length - 1; i >= 0; i--) {
    const t = epochDoAtendimento(doDia[i]);
    if (t >= epoch) continue; // a própria âncora e os do mesmo instante
    if (epoch - t > SEQUENCIA_MAX_S) break;
    epoch = t;
  }
  return { epoch, dia, jaComecou: epoch <= agoraEpoch };
}

/**
 * Os agendamentos que são DESTE paciente, para calcular a chegada.
 *
 * A varredura agrupa a agenda por NOME (a agenda não traz idClient), então duas pacientes homônimas caem no mesmo balaio — e a
 * sessão de uma não pode virar a chegada da outra. A fonte segura é a ficha (`GET /clients/{id}`, por idClient). A agenda, mais
 * fresca, só entra por cima dela: troca a versão de um agendamento que a ficha já conhece, e acrescenta o que carrega o
 * `idTreatment` de um tratamento DESTE paciente (sessão marcada na última hora). Avaliação nova sem id de tratamento espera a
 * ficha renovar (cache de 1 h).
 */
export function agendamentosSegurosDoPaciente(
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
