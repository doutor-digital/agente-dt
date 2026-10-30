import { prisma } from './prisma.js';
import { logger } from './logger.js';

export type FecharSatelites = (p: { ownerTraceId: string; satelliteTraceIds: string[]; falhou: boolean }) => Promise<void>;

/** Fecha os traces "coalescidos" — só os que ainda estão RUNNING (nunca sobrescreve quem outro já fechou). */
export const fecharSatelitesNoBanco: FecharSatelites = async ({ ownerTraceId, satelliteTraceIds, falhou }) => {
  await prisma.executionTrace.updateMany({
    where: { id: { in: satelliteTraceIds }, status: 'RUNNING' },
    data: falhou
      ? { status: 'FAILED', iaDecision: `__coalesced_into__:${ownerTraceId}`, latencyMs: 0, errorMessage: 'o turno do burst falhou' }
      : { status: 'SUCCESS', iaDecision: `__coalesced_into__:${ownerTraceId}`, latencyMs: 0 },
  });
};

/**
 * Roda o turno de um burst: o primeiro trace é o dono, os demais são "satélites" que só são fechados DEPOIS do turno.
 * Fechados antes, o deploy que matasse o turno no meio deixava só o dono como RUNNING e as mensagens dos satélites já
 * constavam como "tratadas": sumiam sem rastro. Com o processo morto o `finally` não roda e os satélites ficam RUNNING
 * (rastreáveis). Turno que lançou erro não esconde a mensagem do satélite atrás de um SUCCESS: eles fecham FAILED.
 */
export async function rodarTurnoDoBurst(
  traceIds: string[],
  turno: (ownerTraceId: string) => Promise<void>,
  fechar: FecharSatelites = fecharSatelitesNoBanco,
): Promise<void> {
  const ownerTraceId = traceIds[0]!;
  const satelliteTraceIds = traceIds.slice(1);
  let falhou = false;
  try {
    await turno(ownerTraceId);
  } catch (err) {
    falhou = true;
    throw err;
  } finally {
    if (satelliteTraceIds.length > 0) {
      await fechar({ ownerTraceId, satelliteTraceIds, falhou }).catch((err) =>
        logger.warn({ err: String(err), ownerTraceId }, 'coalescer: não consegui fechar os traces coalescidos'),
      );
    }
  }
}
