// ============================================================================
// change-log.service.ts — Histórico de melhorias por unidade (clínica).
//
// Cada correção/treino/ajuste feito na IA de uma unidade vira uma linha aqui.
// É a trilha de auditoria que o cliente vê por clínica: "o que já foi feito no
// agente desta unidade, e quando". `addChangeLog` é chamado sempre que se muda
// algo relevante da IA daquela unidade.
// ============================================================================

import { prisma } from '../lib/prisma.js';

export interface ChangeLogInput {
  /** treino | correcao | config | fix | feature */
  category?: string;
  summary: string;
  details?: string | null;
  author?: string | null;
}

/** Linha do tempo (mais recente primeiro) das melhorias da unidade. */
export function listChangeLog(unitId: string) {
  return prisma.unitChangeLog.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

/** Registra uma melhoria/correção na unidade. */
export function addChangeLog(unitId: string, input: ChangeLogInput) {
  return prisma.unitChangeLog.create({
    data: {
      unitId,
      category: input.category ?? 'treino',
      summary: input.summary,
      details: input.details ?? null,
      author: input.author ?? 'IA',
    },
  });
}
