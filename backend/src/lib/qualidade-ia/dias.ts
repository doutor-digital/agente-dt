import type { Dia } from './tipos.js';

export const FUSO = 'America/Sao_Paulo';

/** Dia de calendário (AAAA-MM-DD) de um instante, no fuso de São Paulo. */
export function diaLocal(d: Date): Dia {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Hora, minuto e dia da semana (0 = domingo) de um instante, no fuso de São Paulo. */
export function relogioLocal(d: Date): { hora: number; minuto: number; diaDaSemana: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(d);
  const pega = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const semana = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(pega('weekday'));
  // Algumas versões do ICU devolvem "24" à meia-noite com hour12:false.
  return { hora: Number(pega('hour')) % 24, minuto: Number(pega('minute')), diaDaSemana: semana };
}

export function somarDias(dia: Dia, n: number): Dia {
  return new Date(new Date(`${dia}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Meia-noite de São Paulo daquele dia, como instante UTC. O Brasil não tem horário de verão desde 2019,
 * então o deslocamento é fixo em −03:00 (o mesmo que o placar das campanhas usa).
 */
export function inicioDoDia(dia: Dia): Date {
  return new Date(`${dia}T00:00:00-03:00`);
}

/** Domingo = 0 … sábado = 6, para uma data AAAA-MM-DD. */
export function diaDaSemana(dia: Dia): number {
  return new Date(`${dia}T12:00:00Z`).getUTCDay();
}

/** "26/10 (seg)" */
export function rotuloDoDia(dia: Dia): string {
  const nomes = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)} (${nomes[diaDaSemana(dia)]})`;
}
