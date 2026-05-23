// ============================================================================
// dashboard-mv-refresher.ts — Refresh in-process das materialized views do
// dashboard executivo (mv_unit_daily, mv_unit_daily_channel).
//
// LÓGICA DE ENGENHARIA
// --------------------
// REFRESH MATERIALIZED VIEW CONCURRENTLY a cada N minutos:
//   - CONCURRENTLY mantém leituras destravadas durante o rebuild
//     (exige UNIQUE INDEX nas views — declarado na migration).
//   - setInterval simples, sem dep externa, mesmo padrão do
//     whatsapp-cost-scheduler.
//   - Guard `running` evita overlap quando o refresh ainda não terminou
//     no próximo tick (acontece se a base crescer e o REFRESH passar dos 5min).
//
// REPLICAS: REFRESH CONCURRENTLY em paralelo a partir de réplicas é OK no
// Postgres — ele serializa internamente. Custo extra é o de duplicar o
// trabalho. Pra deploy multi-réplica, mover pra cron externo / k8s CronJob.
// ============================================================================

import { logger } from './logger.js';
import { prisma } from './prisma.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5min — combina com o stale window aceito

let timer: NodeJS.Timeout | null = null;
let running = false;

async function refreshOnce(): Promise<void> {
  if (running) return;
  running = true;
  const startedAt = performance.now();
  try {
    // Executa cada REFRESH numa statement separada — CONCURRENTLY não pode
    // rodar dentro de uma transação maior, e o Prisma $executeRawUnsafe
    // já dispara cada chamada autocommit.
    await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "mv_unit_daily"');
    await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "mv_unit_daily_channel"');
    const latencyMs = Math.round(performance.now() - startedAt);
    logger.debug({ latencyMs }, 'dashboard-mv-refresher: views atualizadas');
  } catch (err) {
    logger.warn({ err }, 'dashboard-mv-refresher: falha no REFRESH');
  } finally {
    running = false;
  }
}

/** Inicia o loop de refresh. Idempotente — chamadas extras são ignoradas. */
export function startDashboardMvRefresher(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  logger.info({ intervalMs }, 'dashboard-mv-refresher: iniciado');
  timer = setInterval(() => void refreshOnce(), intervalMs);
  // Primeiro refresh dispara logo no boot pra MVs não ficarem vazias após
  // qualquer reset (caso da migration recém-aplicada — view é criada vazia
  // só com os agregados existentes na hora do CREATE, mas dados novos
  // entre boot e o primeiro tick ficariam ausentes).
  setImmediate(() => void refreshOnce());
}

export function stopDashboardMvRefresher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
