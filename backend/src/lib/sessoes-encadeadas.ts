/**
 * Sessões "seguidas": do MESMO paciente, no MESMO dia, cada uma começando até 60 min depois do INÍCIO da anterior
 * (9h00 → 9h30 → 10h00). É o caso de quem faz dois tratamentos em horários consecutivos (Timbó, 16/11/2026).
 *
 * Uma regra, dois usos (por isso mora aqui e não em quem a usa):
 *  - `resposta-ao-lembrete`: o toque em "Confirmar presença" no lembrete da primeira vale para a fila toda;
 *  - `sessoes-para-cartao`: depois que a primeira COMEÇOU, a seguinte não vira a ◷ Próxima sessão (senão o robô
 *    do Kommo mandaria um 2º lembrete a quem já está na clínica).
 */
import type { SpineSchedule } from '../services/spine.service.js';

/** Duas sessões do mesmo dia são "seguidas" quando a de trás começa até isto depois do INÍCIO da da frente. */
export const ENCADEADA_ATE_S = 60 * 60;

export const epochDaSessao = (s: Pick<SpineSchedule, 'dateAttendanceUtc'>): number => {
  const ms = Date.parse(String(s.dateAttendanceUtc ?? ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
};

/** O dia (AAAA-MM-DD) no fuso da clínica, como a franquia o entrega. */
export const diaDaSessao = (s: Pick<SpineSchedule, 'dayLocal' | 'dateAttendanceLocal'>): string | null =>
  s.dayLocal ?? (s.dateAttendanceLocal ? s.dateAttendanceLocal.slice(0, 10) : null);

/**
 * PURA: dentre `candidatas` (quem chama já tirou avaliação, desmarcadas etc.), as que formam fila com `ancora`:
 * mesmo dia, começo igual ou posterior ao dela, cada uma até 60 min depois do início da anterior. Só olha para a
 * frente. `max` corta o tamanho da fila.
 */
export function filaApos(ancora: SpineSchedule, candidatas: readonly SpineSchedule[], max = Infinity): SpineSchedule[] {
  const inicio = epochDaSessao(ancora);
  const dia = diaDaSessao(ancora);
  if (!Number.isFinite(inicio) || !dia) return [];
  const vistos = new Set<number>(ancora.idSchedule ? [ancora.idSchedule] : []);
  const daFila = candidatas
    .filter((s) => {
      if (s === ancora) return false;
      if (s.idSchedule) {
        if (vistos.has(s.idSchedule)) return false;
        vistos.add(s.idSchedule);
      }
      const t = epochDaSessao(s);
      return diaDaSessao(s) === dia && Number.isFinite(t) && t >= inicio;
    })
    .sort((a, b) => epochDaSessao(a) - epochDaSessao(b));
  const fila: SpineSchedule[] = [];
  let anterior = inicio;
  for (const s of daFila) {
    const t = epochDaSessao(s);
    if (t - anterior > ENCADEADA_ATE_S || fila.length >= max) break;
    fila.push(s);
    anterior = t;
  }
  return fila;
}
