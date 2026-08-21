import { logger } from './logger.js';
import { prisma } from './prisma.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function refreshOnce(): Promise<void> {
  if (running) return;
  running = true;
  const startedAt = performance.now();
  try {
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

export function startDashboardMvRefresher(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  logger.info({ intervalMs }, 'dashboard-mv-refresher: iniciado');
  timer = setInterval(() => void refreshOnce(), intervalMs);
  setImmediate(() => void refreshOnce());
}

export function stopDashboardMvRefresher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
