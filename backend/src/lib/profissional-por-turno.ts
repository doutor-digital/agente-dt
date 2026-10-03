/**
 * Qual profissional da franquia atende num horário, pela escala da unidade (`units.spine_staff_por_turno`).
 *
 * Por que existe (Taubaté, 03/10/2026): a IA marcava sem `idStaff` e a franquia escolhia a PRIMEIRA
 * profissional da lista — a dona, que não atende. A confirmação chegava ao paciente com o nome errado. A escala
 * de lá é fixa: 08h–13h30 Dra. Juliana Santos (536), 14h–19h30 Dra. Mariane Gomes (704).
 *
 * Puro e tolerante: configuração inválida ou horário fora de qualquer turno devolve null, e quem chama
 * simplesmente não manda `idStaff` (o comportamento de antes).
 */
export interface TurnoDeProfissional {
  /** "HH:MM", inclusivo */
  inicio: string;
  /** "HH:MM", exclusivo: a consulta tem que COMEÇAR antes */
  fim: string;
  idStaff: number;
  nome: string;
}

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutos = (hhmm: string) => {
  const m = HORA.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Lê a configuração do banco (JSON livre) e descarta o que não estiver no formato. */
export function lerTurnos(bruto: unknown): TurnoDeProfissional[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((t): t is TurnoDeProfissional =>
    !!t && typeof t === 'object' &&
    typeof (t as TurnoDeProfissional).inicio === 'string' && minutos((t as TurnoDeProfissional).inicio) !== null &&
    typeof (t as TurnoDeProfissional).fim === 'string' && minutos((t as TurnoDeProfissional).fim) !== null &&
    Number.isInteger((t as TurnoDeProfissional).idStaff) && (t as TurnoDeProfissional).idStaff > 0 &&
    typeof (t as TurnoDeProfissional).nome === 'string');
}

/** `hora` = "HH:MM" (horário local da clínica). */
export function profissionalDoHorario(bruto: unknown, hora: string): TurnoDeProfissional | null {
  const h = minutos(hora.slice(0, 5));
  if (h === null) return null;
  return lerTurnos(bruto).find((t) => h >= minutos(t.inicio)! && h < minutos(t.fim)!) ?? null;
}
