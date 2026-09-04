import type { SpineSchedule } from './spine.service.js';
import { feriadoNacional } from '../lib/feriados.js';

export interface DayHours {
  start: string;
  end: string;
  lunchStart?: string | null;
  lunchEnd?: string | null;
}

export interface AgendaConfig {
  start: string;
  end: string;
  lunchStart: string | null;
  lunchEnd: string | null;
  days: number[];
  slotMinutes: number;
  /** Horário específico por dia da semana ("6" = sábado). Dia ausente usa o padrão. */
  dayHours?: Record<string, DayHours> | null;
}

/** Janela do dia: a específica do dia da semana, se houver; senão a padrão. */
export function janelaDoDia(cfg: AgendaConfig, dow: number): DayHours {
  const esp = cfg.dayHours?.[String(dow)];
  if (esp && /^\d{2}:\d{2}$/.test(esp.start) && /^\d{2}:\d{2}$/.test(esp.end) && esp.end > esp.start) {
    return { start: esp.start, end: esp.end, lunchStart: esp.lunchStart ?? null, lunchEnd: esp.lunchEnd ?? null };
  }
  return { start: cfg.start, end: cfg.end, lunchStart: cfg.lunchStart, lunchEnd: cfg.lunchEnd };
}

export type SlotStatus = 'livre' | 'ocupado' | 'incerto' | 'bloqueado';

export interface AgendaBlockInput {
  dayLocal: string;
  startTime: string;
  endTime: string;
  reason?: string | null;
}

export interface AgendaSlot {
  day: string;
  time: string;
  status: SlotStatus;
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

function eachDay(initialDate: string, endDate: string): string[] {
  const out: string[] = [];
  const ini = new Date(`${initialDate}T00:00:00Z`);
  const fim = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(ini.getTime()) || Number.isNaN(fim.getTime())) return out;
  for (let d = ini; d <= fim; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
    if (out.length > 400) break;
  }
  return out;
}

export function buildAgenda(
  cfg: AgendaConfig,
  schedules: SpineSchedule[],
  range: { initialDate: string; endDate: string },
  nowLocalIso: string,
  blocks: AgendaBlockInput[] = [],
): AgendaSlot[] {
  const passo = Math.max(5, cfg.slotMinutes || 30);
  if (!Number.isFinite(toMinutes(cfg.start)) || !Number.isFinite(toMinutes(cfg.end)) || toMinutes(cfg.end) <= toMinutes(cfg.start)) return [];

  const ocupado = new Map<string, SpineSchedule>();
  for (const s of schedules) {
    if (!s.dayLocal || !s.timeLocal) continue;
    if (!s.isBusy && !s.requiresManualValidation) continue;
    const chave = `${s.dayLocal} ${s.timeLocal}`;
    const anterior = ocupado.get(chave);
    if (!anterior || (!anterior.isBusy && s.isBusy)) ocupado.set(chave, s);
  }

  const out: AgendaSlot[] = [];
  for (const dia of eachDay(range.initialDate, range.endDate)) {
    const dow = new Date(`${dia}T00:00:00Z`).getUTCDay();
    if (!cfg.days.includes(dow)) continue;
    // Sábado costuma ter janela própria (07h–13h); a semana usa o padrão.
    const janela = janelaDoDia(cfg, dow);
    const inicio = toMinutes(janela.start);
    const fim = toMinutes(janela.end);
    if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) continue;
    const almocoIni = janela.lunchStart ? toMinutes(janela.lunchStart) : NaN;
    const almocoFim = janela.lunchEnd ? toMinutes(janela.lunchEnd) : NaN;
    const temAlmoco = Number.isFinite(almocoIni) && Number.isFinite(almocoFim) && almocoFim > almocoIni;
    // Feriado nacional: a clínica não abre. Entra como 'bloqueado' (e não somem os
    // slots) para o motivo aparecer no rastro de quem consultou a agenda.
    const feriado = feriadoNacional(dia);

    for (let m = inicio; m + passo <= fim; m += passo) {
      if (temAlmoco && m < almocoFim && m + passo > almocoIni) continue;

      const hhmm = fromMinutes(m);
      const quando = `${dia}T${hhmm}:00`;
      if (quando <= nowLocalIso) continue;

      if (feriado) {
        out.push({ day: dia, time: hhmm, status: 'bloqueado', motivo: `feriado nacional — ${feriado}` });
        continue;
      }

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
