/**
 * Pausa da IA por janela de tempo, ligada pela recepção.
 *
 * "Vou pausar a Sofia das 8h às 18h" — e às 18h ela volta sozinha. A pausa vale para
 * a unidade inteira: respostas, régua de lead parado, reativação e lembrete de véspera.
 * Nada roda por relógio: cada caminho pergunta `emPausa(unit)` na hora de agir, então
 * a volta é automática no segundo em que a janela termina.
 */
import { randomInt } from 'node:crypto';

export interface JanelaDePausa {
  pausaDesde: Date | null;
  pausaAte: Date | null;
}

export const PAUSA_MAX_DIAS = 7;

export function emPausa(u: JanelaDePausa, agora: Date = new Date()): boolean {
  if (!u.pausaAte) return false;
  if (agora >= u.pausaAte) return false;
  if (u.pausaDesde && agora < u.pausaDesde) return false;
  return true;
}

/** Pausa marcada para começar depois (ex.: amanhã das 8h às 12h). */
export function pausaAgendada(u: JanelaDePausa, agora: Date = new Date()): boolean {
  return !!u.pausaAte && !!u.pausaDesde && agora < u.pausaDesde && agora < u.pausaAte;
}

export function horaLocal(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 16);
  }
}

export function descreverPausa(u: JanelaDePausa & { pausaMotivo?: string | null; pausaPor?: string | null }, tz = 'America/Sao_Paulo'): string {
  if (!u.pausaAte) return 'IA ativa';
  const ate = horaLocal(u.pausaAte, tz);
  const desde = u.pausaDesde ? horaLocal(u.pausaDesde, tz) : null;
  const quem = u.pausaPor ? ` por ${u.pausaPor}` : '';
  const motivo = u.pausaMotivo ? ` (${u.pausaMotivo})` : '';
  return desde ? `IA pausada de ${desde} até ${ate}${quem}${motivo}` : `IA pausada até ${ate}${quem}${motivo}`;
}

/** Código de 6 dígitos que a recepção usa na página de pausa. */
export function gerarCodigoPausa(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface PedidoDePausa {
  ate: Date;
  desde?: Date | null;
}

/** Regras do pedido: fim no futuro, no máximo 7 dias, início antes do fim. */
export function validarPedidoDePausa(p: PedidoDePausa, agora: Date = new Date()): string | null {
  if (Number.isNaN(p.ate.getTime())) return 'hora de término inválida';
  if (p.ate <= agora) return 'a hora de término precisa estar no futuro';
  if (p.ate.getTime() - agora.getTime() > PAUSA_MAX_DIAS * 24 * 3600_000) return `a pausa pode durar no máximo ${PAUSA_MAX_DIAS} dias`;
  if (p.desde && Number.isNaN(p.desde.getTime())) return 'hora de início inválida';
  if (p.desde && p.desde >= p.ate) return 'o início precisa ser antes do término';
  return null;
}
