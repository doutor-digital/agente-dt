/**
 * Qual é a PRÓXIMA sessão do paciente, segundo a franquia.
 *
 * A versão anterior aceitava só `AGENDADO (37)` e `CONFIRMADO (38)`. Só que a
 * franquia tem um terceiro estado para agendamento que vai acontecer:
 * `REMARCADO (41)` — a sessão que foi movida de dia. Ela é um compromisso tão
 * real quanto as outras, e é o que a tela da franquia mostra como próxima.
 *
 * Caso Fabio Sousa Santos (Imperatriz, 19/09/2026): tinha 19/09 DESMARCADO e
 * 23/09 REMARCADO. Como o 41 não entrava na conta, a próxima sessão vinha `null`,
 * o cartão ficou com a data velha (19/09) e a régua de véspera mandou às 05h
 * "a sua sessão de hoje está marcada para 19/09" para alguém cuja sessão daquele
 * dia tinha sido desmarcada. A recepção teve que escrever "desconsidere a
 * mensagem". Um status faltando numa lista virou pedido de desculpa ao paciente.
 *
 * `DESMARCADO (57)` continua fora: aquele horário voltou para a agenda.
 */
import { SpineService } from './spine.service.js';

const { AGENDADO, CONFIRMADO, REMARCADO, DESMARCADO } = SpineService.SPINE_STATUS;

/** Estados de um agendamento que ainda vai acontecer. */
export const VAI_ACONTECER: number[] = [AGENDADO, CONFIRMADO, REMARCADO];

export interface SessaoBruta {
  dateAttendanceUtc?: string | null;
  dateAttendanceLocal?: string | null;
  idStatus?: number | null;
}

export function ehFutura(s: SessaoBruta, agoraMs: number): boolean {
  const t = Date.parse(String(s.dateAttendanceUtc ?? ''));
  return Number.isFinite(t) && t > agoraMs;
}

/**
 * A próxima sessão: a mais próxima no tempo, entre as que ainda vão acontecer.
 *
 * Desmarcada nunca conta. Sem status conhecido também não — não vou carimbar uma
 * data no cartão do paciente com base em algo que não sei ler, porque é dessa
 * data que sai a mensagem de véspera.
 */
export function proximaSessao(sessoes: SessaoBruta[], agoraMs: number): SessaoBruta | null {
  return (
    sessoes
      .filter((s) => ehFutura(s, agoraMs))
      .filter((s) => s.idStatus != null && s.idStatus !== DESMARCADO && VAI_ACONTECER.includes(s.idStatus))
      .sort((a, b) => Date.parse(String(a.dateAttendanceUtc)) - Date.parse(String(b.dateAttendanceUtc)))[0] ?? null
  );
}
