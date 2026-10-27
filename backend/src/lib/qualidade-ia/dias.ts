import type { Dia } from './tipos.js';

import { FUSO_PADRAO, partesNoFuso } from '../fuso.js';

export const FUSO = FUSO_PADRAO;

/** Dia de calendário (AAAA-MM-DD) de um instante, no fuso de São Paulo. */
export function diaLocal(d: Date): Dia {
  const p = partesNoFuso(d, FUSO);
  return `${String(p.ano).padStart(4, '0')}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

/** Hora, minuto e dia da semana (0 = domingo) de um instante, no fuso de São Paulo. */
export function relogioLocal(d: Date): { hora: number; minuto: number; diaDaSemana: number } {
  const p = partesNoFuso(d, FUSO);
  return { hora: p.hora, minuto: p.min, diaDaSemana: new Date(Date.UTC(p.ano, p.mes - 1, p.dia)).getUTCDay() };
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
