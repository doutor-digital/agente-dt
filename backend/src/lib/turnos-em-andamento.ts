/**
 * Conta os turnos da IA que estão rodando (da chamada ao modelo até a última ferramenta) para o desligamento esperar por eles.
 *
 * Sem isto o SIGTERM do deploy chamava `process.exit(0)` na hora: o turno que estava entre a resposta do modelo
 * (`tool_use`) e a ferramenta morria no meio, o checkpoint ficava com a chamada SEM resultado e a conversa inteira
 * passava a tomar 400 do modelo (Canaã, lead 29012474, 26/10: deploy 14:10:16, trace RUNNING até hoje).
 * O `stop_grace_period` do Swarm existia e não era usado.
 */

import { drenarCoalescer } from './agent-coalescer.js';

let emAndamento = 0;

export function turnosEmAndamento(): number {
  return emAndamento;
}

export async function comTurnoEmAndamento<T>(fn: () => Promise<T>): Promise<T> {
  emAndamento++;
  try {
    return await fn();
  } finally {
    emAndamento--;
  }
}

/**
 * O que o SIGTERM espera, nesta ordem: (1) a fila do coalescer — mensagem que ainda espera a janela de 8 s ou o turno
 * encadeado vira turno AGORA (Timbó, 30/10/2026: a foto da paciente morreu na fila); (2) os turnos fora do coalescer
 * (Salesbot, Meta, etc.). Teto único `maxMs` para os dois.
 */
export async function esperarTurnosDoDesligamento(maxMs: number): Promise<{ filaRestante: number; restantes: number; esperouMs: number }> {
  const inicio = Date.now();
  const fila = await drenarCoalescer(maxMs);
  const emCurso = await aguardarTurnos(Math.max(0, maxMs - (Date.now() - inicio)));
  return { filaRestante: fila.restantes, restantes: emCurso.restantes, esperouMs: Date.now() - inicio };
}

/** Espera os turnos acabarem, no máximo `maxMs`. Devolve quantos ainda restavam (0 = saiu limpo). */
export async function aguardarTurnos(maxMs: number, passoMs = 100): Promise<{ restantes: number; esperouMs: number }> {
  const inicio = Date.now();
  while (emAndamento > 0 && Date.now() - inicio < maxMs) {
    await new Promise((r) => setTimeout(r, passoMs));
  }
  return { restantes: emAndamento, esperouMs: Date.now() - inicio };
}
