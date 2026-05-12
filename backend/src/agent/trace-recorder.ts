// ============================================================================
// trace-recorder.ts — Adapter para gravar steps de execução no Postgres.
//
// LÓGICA DE ENGENHARIA
// --------------------
// O LangGraph não conhece nosso domínio de observabilidade — nem deve.
// Esta classe é a PONTE: cada nó/tool do grafo chama `recorder.step(...)`
// passando o que aconteceu, e este módulo persiste no banco no formato
// que o dashboard React consome.
//
// Mantemos um contador `sequence` interno para garantir ordenação estável
// no feed mesmo quando dois steps são gravados no mesmo milissegundo
// (improvável, mas o timestamp não é suficiente como chave de ordenação).
//
// Async sem await: na assinatura `step()` retornamos a Promise mas NÃO
// bloqueamos o grafo. Se uma escrita de log falhar, logamos e seguimos —
// observabilidade nunca deve derrubar a execução principal.
// ============================================================================

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { StepKind } from '@prisma/client';

export class TraceRecorder {
  private sequence = 0;

  constructor(public readonly traceId: string) {}

  async step(args: {
    kind: StepKind;
    title: string;
    payload?: unknown;
    latencyMs?: number;
  }): Promise<void> {
    const seq = ++this.sequence;
    try {
      await prisma.executionStep.create({
        data: {
          traceId: this.traceId,
          sequence: seq,
          kind: args.kind,
          title: args.title,
          payload: args.payload === undefined ? undefined : (args.payload as object),
          latencyMs: args.latencyMs,
        },
      });
    } catch (err) {
      // Observabilidade não pode quebrar o agente. Logamos e seguimos.
      logger.error({ err, traceId: this.traceId, seq }, 'falha ao gravar step');
    }
  }

  async finalize(args: {
    status: 'SUCCESS' | 'FAILED';
    latencyMs: number;
    iaDecision?: unknown;
    errorMessage?: string;
  }): Promise<void> {
    try {
      await prisma.executionTrace.update({
        where: { id: this.traceId },
        data: {
          status: args.status,
          latencyMs: args.latencyMs,
          iaDecision: args.iaDecision === undefined ? undefined : (args.iaDecision as object),
          errorMessage: args.errorMessage,
        },
      });
    } catch (err) {
      logger.error({ err, traceId: this.traceId }, 'falha ao finalizar trace');
    }
  }
}
