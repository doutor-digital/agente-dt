import { logger } from './logger.js';
import { syncAllUnitsWhatsappCosts } from '../services/whatsapp-cost-sync.service.js';

const TICK_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_TARGET_HOUR_UTC = 3;
const LOOKBACK_DAYS = 7;

let timer: NodeJS.Timeout | null = null;
let lastRunIsoDay: string | null = null;
let running = false;

function isoDayUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function tick(targetHourUtc: number): Promise<void> {
  if (running) return;
  const now = new Date();
  const today = isoDayUTC(now);
  if (now.getUTCHours() !== targetHourUtc) return;
  if (lastRunIsoDay === today) return;
  running = true;
  lastRunIsoDay = today;
  try {
    logger.info({ targetHourUtc, today }, 'whatsapp-cost-scheduler: tick disparou sync');
    const results = await syncAllUnitsWhatsappCosts({ lookbackDays: LOOKBACK_DAYS });
    logger.info(
      {
        units: results.length,
        okCount: results.filter((r) => r.ok).length,
        pricingRows: results.reduce((s, r) => s + r.pricingRowsUpserted, 0),
        templateRows: results.reduce((s, r) => s + r.templateRowsUpserted, 0),
      },
      'whatsapp-cost-scheduler: sync diário concluído',
    );
  } catch (err) {
    logger.error({ err }, 'whatsapp-cost-scheduler: sync falhou');
  } finally {
    running = false;
  }
}

export function startWhatsappCostScheduler(targetHourUtc = DEFAULT_TARGET_HOUR_UTC): void {
  if (timer) return;
  logger.info({ targetHourUtc }, 'whatsapp-cost-scheduler: iniciado');
  timer = setInterval(() => void tick(targetHourUtc), TICK_INTERVAL_MS);
  setImmediate(() => void tick(targetHourUtc));
}

export function stopWhatsappCostScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
