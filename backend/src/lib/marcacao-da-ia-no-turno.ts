/**
 * "A IA marcou a consulta NESTE turno?" — para os carimbos que dizem que ela marcou.
 *
 * Caso Ana Christina (Timbó, 29/10/2026): no mesmo turno, em paralelo, o modelo chamou `agendar_consulta` (que falhou: a
 * recepção já tinha marcado) e a captura de campos, que gravou no cartão "⬢ Agendamento feito por = IA" e
 * "✓ Situação da consulta = Agendado" ANTES do resultado do agendamento. Quem marcou foi a recepção; o cartão ficou
 * dizendo que foi a IA.
 *
 * `agendar_consulta` já carimba esses dois campos sozinho quando dá certo. A gravação avulsa de "feito por = IA" (que AFIRMA
 * que a IA marcou) só vale se a marcação da IA deu certo no turno; "Situação = Agendado" é o estado da consulta e não é
 * travado (revisão do sênior, 29/10: no caso Timbó ela estava, de fato, agendada) — e, como as ferramentas rodam em paralelo, quem vai gravar ESPERA a marcação
 * em andamento terminar (com teto), em vez de adivinhar.
 *
 * Estado por `traceId` (um por turno), em memória, com validade curta.
 */

import { ehCabecalhoDeGrupo, normalizarNome } from './kommo-schema.js';

/** O campo que afirma "a IA marcou" (com o valor "IA"), e o que diz o estado da consulta (livre: não afirma quem marcou). */
export const CAMPO_FEITO_POR = '⬢ Agendamento feito por';
export const CAMPO_SITUACAO_CONSULTA = '✓ Situação da consulta';

interface Turno {
  em: number;
  ok: boolean;
  emCurso: number;
  espera: Array<() => void>;
}

const turnos = new Map<string, Turno>();
const TTL_MS = 10 * 60_000;

function turno(traceId: string): Turno {
  const agora = Date.now();
  if (turnos.size > 500) for (const [k, t] of turnos) if (agora - t.em > TTL_MS && t.emCurso === 0) turnos.delete(k);
  let t = turnos.get(traceId);
  if (!t) {
    t = { em: agora, ok: false, emCurso: 0, espera: [] };
    turnos.set(traceId, t);
  }
  return t;
}

/**
 * PURA. Este campo + valor afirmam que a IA marcou a consulta?
 *
 * SÓ "⬢ Agendamento feito por = IA": é ele que diz QUEM marcou. "✓ Situação da consulta = Agendado" é o estado da consulta, não
 * de quem a marcou (no caso Timbó era verdade: a consulta estava agendada, pela recepção) e fica livre para qualquer escritor.
 * O nome do campo compara pela mesma normalização com que o Kommo resolve campo por nome (`campoPorNome`).
 */
export function ehCarimboDeMarcacaoDaIa(campo: string, valor: unknown): boolean {
  if (ehCabecalhoDeGrupo(campo) || normalizarNome(campo) !== normalizarNome(CAMPO_FEITO_POR)) return false;
  const v = Array.isArray(valor) ? valor.map(String).join(';') : String(valor ?? '');
  return normalizarNome(v) === 'ia';
}

/** Envolve uma tentativa de marcar (agendar/remarcar): enquanto roda, quem quer carimbar espera o desfecho. */
export async function comMarcacaoEmCurso<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
  const t = turno(traceId);
  t.emCurso++;
  try {
    return await fn();
  } finally {
    t.emCurso--;
    if (t.emCurso === 0) for (const acorda of t.espera.splice(0)) acorda();
  }
}

/** A marcação da IA deu certo neste turno (a franquia devolveu o idSchedule). */
export function registrarMarcacaoDaIa(traceId: string): void {
  turno(traceId).ok = true;
}

function dormir(ms: number): Promise<void> {
  return new Promise((r) => {
    const h = setTimeout(r, ms);
    h.unref?.();
  });
}

/**
 * A IA marcou neste turno? Se a marcação ainda está rodando (ferramentas em paralelo), espera o fim, com teto. Se nada
 * está rodando, dá uma pequena folga para a chamada paralela que ainda não começou, e então responde.
 */
export async function aguardarMarcacaoDaIa(traceId: string | undefined, o: { gracaMs?: number; limiteMs?: number } = {}): Promise<boolean> {
  if (!traceId) return false;
  if (turnos.get(traceId)?.ok) return true;
  if (!(turnos.get(traceId)?.emCurso)) await dormir(o.gracaMs ?? 300);
  const t = turnos.get(traceId);
  if (!t) return false;
  if (t.ok) return true;
  if (t.emCurso > 0) {
    let acorda: () => void = () => undefined;
    await Promise.race([new Promise<void>((r) => t.espera.push((acorda = r))), dormir(o.limiteMs ?? 120_000)]);
    // estourou o teto: não deixa o resolvedor preso na lista de um turno que pode nunca terminar
    const i = t.espera.indexOf(acorda);
    if (i >= 0) t.espera.splice(i, 1);
  }
  return turnos.get(traceId)?.ok === true;
}

export function _limparTurnosParaTeste(): void {
  turnos.clear();
}

/** Quantos pedidos de carimbo estão parados esperando este turno (o teto de espera tem de esvaziar isto). */
export function _esperandoParaTeste(traceId: string): number {
  return turnos.get(traceId)?.espera.length ?? 0;
}
