/**
 * Avisa a equipe quando o paciente continua escrevendo com a IA pausada.
 *
 * Até aqui, lead pausado que mandava mensagem caía num `return` silencioso: o
 * agente não respondia e ninguém ficava sabendo. Foi assim que a Neta (Boa
 * Vista, 29/08) escreveu "urgente!!!!!" depois de um handoff clínico e não
 * recebeu nada — a IA estava desligada e o CRM não avisou que ela seguia ali.
 *
 * O alerta por SLA que já existe é por TEMPO ("ninguém respondeu em N minutos").
 * Este é por SINAL: o paciente está do outro lado, digitando. É uma informação
 * diferente e mais forte, porque o lead ainda está quente.
 *
 * Não desliga nem enfraquece o protocolo clínico: a IA continua pausada e quem
 * assume é gente. Só deixa de ser um silêncio que ninguém enxerga.
 */

const ultimoAviso = new Map<string, number>();

/** Uma cutucada por lead a cada 10 min — paciente aflito manda 5 mensagens seguidas. */
export const INTERVALO_AVISO_MS = 10 * 60_000;

export function devoAvisar(chave: string, agora: number = Date.now()): boolean {
  const anterior = ultimoAviso.get(chave);
  if (anterior !== undefined && agora - anterior < INTERVALO_AVISO_MS) return false;
  ultimoAviso.set(chave, agora);
  return true;
}

export function esquecerAviso(chave: string): void {
  ultimoAviso.delete(chave);
}

/** Só pra teste: zera o estado entre casos. */
export function limparAvisos(): void {
  ultimoAviso.clear();
}
