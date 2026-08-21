import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { StepKind } from '@prisma/client';

export class TraceRecorder {
  private sequence = 0;

  constructor(public readonly traceId: string, public readonly unitId: string | null = null) {}

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

export async function syncRecorderSequence(recorder: TraceRecorder, traceId: string): Promise<void> {
  const last = await prisma.executionStep.findFirst({
    where: { traceId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  if (last) {
    (recorder as unknown as { sequence: number }).sequence = last.sequence;
  }
}
