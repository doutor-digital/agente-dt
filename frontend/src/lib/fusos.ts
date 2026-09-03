/**
 * Fusos horários do Brasil que uma unidade pode usar.
 *
 * A rede é quase toda UTC−3, mas Boa Vista (RR) é UTC−4 — e a hora errada no
 * agente vira tag de entrada no dia seguinte, lembrete fora de hora e
 * "bom dia" às 23h. O rótulo mostra o UTC porque é assim que o time fala
 * ("Boa Vista é menos quatro"), não pelo nome IANA.
 */
export interface FusoBR {
  tz: string;
  cidade: string;
  utc: string;
}

export const FUSOS_BR: FusoBR[] = [
  { tz: 'America/Sao_Paulo', cidade: 'Brasília · São Paulo · Minas · Espírito Santo · Goiás · Paraná', utc: 'UTC−03:00' },
  { tz: 'America/Araguaina', cidade: 'Araguaína · Tocantins', utc: 'UTC−03:00' },
  { tz: 'America/Belem', cidade: 'Belém · Pará (leste) · Amapá', utc: 'UTC−03:00' },
  { tz: 'America/Fortaleza', cidade: 'Fortaleza · Maranhão · Ceará · Piauí · Rio Grande do Norte · Paraíba', utc: 'UTC−03:00' },
  { tz: 'America/Recife', cidade: 'Recife · Pernambuco', utc: 'UTC−03:00' },
  { tz: 'America/Maceio', cidade: 'Maceió · Alagoas · Sergipe', utc: 'UTC−03:00' },
  { tz: 'America/Bahia', cidade: 'Salvador · Bahia', utc: 'UTC−03:00' },
  { tz: 'America/Boa_Vista', cidade: 'Boa Vista · Roraima', utc: 'UTC−04:00' },
  { tz: 'America/Manaus', cidade: 'Manaus · Amazonas (leste)', utc: 'UTC−04:00' },
  { tz: 'America/Porto_Velho', cidade: 'Porto Velho · Rondônia', utc: 'UTC−04:00' },
  { tz: 'America/Cuiaba', cidade: 'Cuiabá · Mato Grosso', utc: 'UTC−04:00' },
  { tz: 'America/Campo_Grande', cidade: 'Campo Grande · Mato Grosso do Sul', utc: 'UTC−04:00' },
  { tz: 'America/Rio_Branco', cidade: 'Rio Branco · Acre · Amazonas (oeste)', utc: 'UTC−05:00' },
  { tz: 'America/Noronha', cidade: 'Fernando de Noronha', utc: 'UTC−02:00' },
];

export function rotuloFuso(tz: string): string {
  const f = FUSOS_BR.find((x) => x.tz === tz);
  return f ? `${f.cidade} (${f.utc})` : tz;
}

/** "14:35" no fuso pedido; vazio se o fuso for inválido. */
export function horaAgoraEm(tz: string, agora: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(agora);
  } catch {
    return '';
  }
}
