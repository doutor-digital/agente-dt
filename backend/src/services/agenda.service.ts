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

/**
 * Quanto um agendamento ocupa na agenda da FRANQUIA, pra ela recusar outro por cima: 30 minutos, seja
 * qual for o passo da grade da unidade.
 *
 * Medido em Mossoró (grade de 45 min desde 02/10/2026), nas sondagens de 19/10: a franquia recusou
 * 09:45 e 15:45 de 20/10 (há consulta às 10:00, e às 15:30 e 16:00) e aceitou 13:30 (há consulta às
 * 14:00) e, em 22/10, 10:30 (há consulta às 10:00 e às 11:00). Só "30 min de cada lado" explica as
 * nove respostas daquele dia: com 45 min, 13:30 e 10:30 teriam sido recusados. Antes disto a grade
 * só comparava o horário de início exato — um 09:45 da grade nova não via a consulta das 10:00 da
 * grade antiga, a Sofia sondava o horário, a franquia dizia "400: Horário não disponível" (79 vezes
 * em 48 h, quase todas em Mossoró) e o dia saía com 2 de 9 horários.
 *
 * Em grade de 30 min com tudo marcado em :00/:30, "30 min de cada lado" é o mesmo que "mesmo
 * início" — nada muda nas unidades que nunca mudaram o passo.
 */
export const DURACAO_NA_FRANQUIA_MIN = 30;

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
  /** Por dia, o início (em minutos) de cada agendamento que ocupa a agenda — pra achar quem fica por cima. */
  const ocupadosDoDia = new Map<string, Array<{ minuto: number; s: SpineSchedule }>>();
  for (const s of schedules) {
    if (!s.dayLocal || !s.timeLocal) continue;
    if (!s.isBusy && !s.requiresManualValidation) continue;
    const chave = `${s.dayLocal} ${s.timeLocal}`;
    const anterior = ocupado.get(chave);
    if (!anterior || (!anterior.isBusy && s.isBusy)) ocupado.set(chave, s);
    // Desmarcado (validar à mão) só pesa no próprio horário, como antes: a franquia não o conta como ocupado.
    const minuto = toMinutes(s.timeLocal);
    if (s.isBusy && Number.isFinite(minuto)) {
      const doDia = ocupadosDoDia.get(s.dayLocal);
      if (doDia) doDia.push({ minuto, s });
      else ocupadosDoDia.set(s.dayLocal, [{ minuto, s }]);
    }
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
      // Sem ninguém no horário exato, ainda pode haver consulta começando menos de 30 min antes ou depois
      // (grade de 45 min sobre consultas antigas de 30): a franquia recusa, então não é livre.
      const porCima = achado
        ? undefined
        : ocupadosDoDia.get(dia)?.find((o) => Math.abs(o.minuto - m) < DURACAO_NA_FRANQUIA_MIN);
      if (porCima) {
        out.push({
          day: dia,
          time: hhmm,
          status: 'ocupado',
          motivo: `encosta na consulta das ${porCima.s.timeLocal} (${porCima.s.statusName ?? `status ${porCima.s.idStatus}`})`,
        });
      } else if (!achado) {
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
