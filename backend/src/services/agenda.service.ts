// ============================================================================
// agenda.service.ts — Traduz "histórico de agendamentos" em "horários ofertáveis".
//
// LÓGICA DE ENGENHARIA
// --------------------
// Isto NÃO é um motor de disponibilidade. É uma grade determinística:
//
//   grade = dias de atendimento × janela de funcionamento − almoço − passado
//   oferta = grade − horários visivelmente ocupados
//
// Nenhuma heurística, nenhum palpite. É de propósito: a API da franquia não
// expõe bloqueios de agenda, então qualquer tentativa de "adivinhar" o que ela
// não conta produziria confiança falsa. O que a gente pode afirmar com
// honestidade é só isto — "não vejo nada marcado aqui" — e é isso que a
// estrutura devolve, com o grau de certeza explícito em cada slot.
//
// O horário de almoço é subtraído da grade, não filtrado depois: um slot que
// começa 11:45 e cruza o início do almoço às 12:00 também sai. Filtrar só pelo
// início deixaria a consulta invadindo o intervalo.
// ============================================================================

import type { SpineSchedule } from './spine.service.js';

export interface AgendaConfig {
  /** "HH:mm" */
  start: string;
  /** "HH:mm" */
  end: string;
  lunchStart: string | null;
  lunchEnd: string | null;
  /** 0=domingo … 6=sábado */
  days: number[];
  slotMinutes: number;
}

export type SlotStatus = 'livre' | 'ocupado' | 'incerto' | 'bloqueado';

/** Bloqueio manual — o dado que a API da franquia não expõe. */
export interface AgendaBlockInput {
  dayLocal: string;
  /** "HH:mm" inclusive. */
  startTime: string;
  /** "HH:mm" exclusive. */
  endTime: string;
  reason?: string | null;
}

export interface AgendaSlot {
  /** "YYYY-MM-DD" no fuso da clínica. */
  day: string;
  /** "HH:mm" no fuso da clínica. */
  time: string;
  status: SlotStatus;
  /** Presente quando o slot não está livre. */
  motivo?: string;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number(n));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

function fromMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Percorre os dias do intervalo, inclusive, no fuso da clínica. */
function eachDay(initialDate: string, endDate: string): string[] {
  const out: string[] = [];
  const ini = new Date(`${initialDate}T00:00:00Z`);
  const fim = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(ini.getTime()) || Number.isNaN(fim.getTime())) return out;
  for (let d = ini; d <= fim; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
    if (out.length > 400) break; // trava de sanidade
  }
  return out;
}

export function buildAgenda(
  cfg: AgendaConfig,
  schedules: SpineSchedule[],
  range: { initialDate: string; endDate: string },
  /** Instante "agora" no fuso da clínica, ISO curto — slots anteriores saem. */
  nowLocalIso: string,
  /** Bloqueios manuais da recepção. Vencem tudo. */
  blocks: AgendaBlockInput[] = [],
): AgendaSlot[] {
  const inicio = toMinutes(cfg.start);
  const fim = toMinutes(cfg.end);
  const passo = Math.max(5, cfg.slotMinutes || 30);
  if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) return [];

  const almocoIni = cfg.lunchStart ? toMinutes(cfg.lunchStart) : NaN;
  const almocoFim = cfg.lunchEnd ? toMinutes(cfg.lunchEnd) : NaN;
  const temAlmoco = Number.isFinite(almocoIni) && Number.isFinite(almocoFim) && almocoFim > almocoIni;

  // Índice por "dia HH:mm" — evita varrer a lista inteira por slot.
  const ocupado = new Map<string, SpineSchedule>();
  for (const s of schedules) {
    if (!s.dayLocal || !s.timeLocal) continue;
    // Todo registro entra no índice: ocupado de verdade OU desmarcado (que
    // vira "conferir"). Nenhum agendamento é descartado em silêncio.
    if (!s.isBusy && !s.requiresManualValidation) continue;
    const chave = `${s.dayLocal} ${s.timeLocal}`;
    const anterior = ocupado.get(chave);
    // Ocupado real vence incerto: se dois registros caem no mesmo horário e um
    // deles é atendimento confirmado, o horário está tomado, ponto.
    if (!anterior || (!anterior.isBusy && s.isBusy)) ocupado.set(chave, s);
  }

  const out: AgendaSlot[] = [];
  for (const dia of eachDay(range.initialDate, range.endDate)) {
    const dow = new Date(`${dia}T00:00:00Z`).getUTCDay();
    if (!cfg.days.includes(dow)) continue;

    for (let m = inicio; m + passo <= fim; m += passo) {
      // O slot INTEIRO precisa caber fora do almoço, não só o começo.
      if (temAlmoco && m < almocoFim && m + passo > almocoIni) continue;

      const hhmm = fromMinutes(m);
      const quando = `${dia}T${hhmm}:00`;
      if (quando <= nowLocalIso) continue;

      // BLOQUEIO VENCE TUDO, inclusive um agendamento que exista no mesmo
      // horário. Se a recepção bloqueou, ela sabe de algo que a API não conta —
      // é justamente esse o motivo do recurso existir.
      const bloqueio = blocks.find(
        (b) => b.dayLocal === dia && hhmm >= b.startTime && hhmm < b.endTime,
      );
      if (bloqueio) {
        out.push({
          day: dia,
          time: hhmm,
          status: 'bloqueado',
          motivo: bloqueio.reason?.trim() || 'bloqueado pela recepção',
        });
        continue;
      }

      const achado = ocupado.get(`${dia} ${hhmm}`);
      if (!achado) {
        out.push({ day: dia, time: hhmm, status: 'livre' });
      } else if (achado.isBusy) {
        out.push({
          day: dia,
          time: hhmm,
          status: 'ocupado',
          motivo: achado.statusName ?? `status ${achado.idStatus}`,
        });
      } else {
        out.push({
          day: dia,
          time: hhmm,
          status: 'incerto',
          motivo: 'paciente desmarcou — pode haver bloqueio não visível na API',
        });
      }
    }
  }
  return out;
}

export const AgendaService = { buildAgenda };
