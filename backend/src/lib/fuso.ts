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
