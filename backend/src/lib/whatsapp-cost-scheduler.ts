// ============================================================================
// whatsapp-cost-scheduler.ts — Loop in-process que dispara sync diário.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Sem node-cron pra não adicionar dependência. Estratégia:
//   - setInterval que dispara a cada 60 minutos.
//   - Toda vez checa se a hora UTC atual é a "hora-alvo" (default 3 AM)
//     E se não rodou ainda hoje.
//   - Rodada armazenada em memória — se o processo restart, pode rodar 2x
//     no mesmo dia, mas o upsert é idempotente.
//
// Em deploys com várias réplicas isso roda em todas — não é ideal mas como
// é upsert idempotente, não corrompe dados. Pra arquitetura limpa, mover
// pra cron externo (k8s CronJob) chamando o script `sync-whatsapp-costs.ts`.
// ============================================================================

import { logger } from './logger.js';
import { syncAllUnitsWhatsappCosts } from '../services/whatsapp-cost-sync.service.js';

const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
const DEFAULT_TARGET_HOUR_UTC = 3; // 03:00 UTC = 00:00 BRT, fora de pico
const LOOKBACK_DAYS = 7;

let timer: NodeJS.Timeout | null = null;
let lastRunIsoDay: string | null = null;
let running = false;

function isoDayUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function tick(targetHourUtc: number): Promise<void> {
  if (running) return; // never overlap
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

/** Inicia o scheduler. Idempotente — chamadas extras são ignoradas. */
export function startWhatsappCostScheduler(targetHourUtc = DEFAULT_TARGET_HOUR_UTC): void {
  if (timer) return;
  logger.info({ targetHourUtc }, 'whatsapp-cost-scheduler: iniciado');
  timer = setInterval(() => void tick(targetHourUtc), TICK_INTERVAL_MS);
  // Tick inicial — se o processo subir após o horário-alvo e não rodou hoje,
  // dispara já na próxima iteração da event loop.
  setImmediate(() => void tick(targetHourUtc));
}

export function stopWhatsappCostScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
