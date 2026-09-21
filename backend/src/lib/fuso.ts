import type { Unit } from '@prisma/client';

/**
 * Um fuso por unidade.
 *
 * Boa Vista fica em UTC−4; o resto da rede em UTC−3. Até 03/09/2026 a data de
 * entrada do lead, o título do cartão e o sandbox do console eram formatados em
 * America/Sao_Paulo fixo — em Boa Vista, um lead que chegava às 23h30 ganhava a
 * tag do dia seguinte. A unidade tem dois campos históricos para o mesmo fato
 * (`businessHoursTimezone`, usado no horário comercial e no prompt, e
 * `spineTimezone`, usado na agenda da franquia); a leitura é sempre por aqui,
 * e o PATCH da unidade espelha um no outro, para nunca mais divergirem.
 */
export const FUSO_PADRAO = 'America/Sao_Paulo';

export function fusoValido(tz: string | null | undefined): boolean {
  if (!tz || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function fusoDaUnidade(
  unit: Partial<Pick<Unit, 'businessHoursTimezone' | 'spineTimezone'>> | null | undefined,
): string {
  const candidatos = [unit?.businessHoursTimezone, unit?.spineTimezone];
  for (const tz of candidatos) if (fusoValido(tz)) return tz as string;
  return FUSO_PADRAO;
}

/** Data dd/mm/aaaa no fuso da unidade — é o que vai para tag e título do lead. */
export function dataBRNoFuso(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: fusoValido(tz) ? tz : FUSO_PADRAO,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(ms));
}

function partesNoFuso(d: Date, tz: string): { ano: number; mes: number; dia: number; hora: number; min: number; seg: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? '0');
  return { ano: n('year'), mes: n('month'), dia: n('day'), hora: n('hour'), min: n('minute'), seg: n('second') };
}

/** Diferença (min) entre o relógio do fuso e o UTC naquele instante. São Paulo: -180; Manaus/Boa Vista: -240. */
export function offsetMinutosNoFuso(d: Date, tz: string): number {
  const p = partesNoFuso(d, tz);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.min, p.seg);
  return Math.round((comoUtc - d.getTime()) / 60_000);
}

/** Meia-noite local de um dia 1º (ano/mês do calendário do fuso), como instante UTC. */
function meiaNoiteDoDia1(ano: number, mes1a12: number, tz: string): Date {
  const candidato = new Date(Date.UTC(ano, mes1a12 - 1, 1, 0, 0, 0));
  return new Date(candidato.getTime() - offsetMinutosNoFuso(candidato, tz) * 60_000);
}

/** Meia-noite do dia 1º do mês corrente NO FUSO, como instante UTC. */
export function inicioDoMesNoFuso(agora: Date, tz: string): Date {
  const p = partesNoFuso(agora, tz);
  return meiaNoiteDoDia1(p.ano, p.mes, tz);
}

/** Meia-noite do dia 1º do mês SEGUINTE no fuso (quando uma pausa "até o dia 1º" acaba). */
export function inicioDoProximoMesNoFuso(agora: Date, tz: string): Date {
  const p = partesNoFuso(agora, tz);
  return p.mes === 12 ? meiaNoiteDoDia1(p.ano + 1, 1, tz) : meiaNoiteDoDia1(p.ano, p.mes + 1, tz);
}

/** "2026-09" — o mês corrente no fuso. */
export function mesNoFuso(agora: Date, tz: string): string {
  const p = partesNoFuso(agora, tz);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}`;
}
