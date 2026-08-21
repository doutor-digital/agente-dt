import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { apiRouter } from './routes/api.routes.js';
import { getCheckpointer } from './agent/graph.js';
import { ensureDefaultUnit } from './services/units.service.js';
import { startWhatsappCostScheduler } from './lib/whatsapp-cost-scheduler.js';
import { startDashboardMvRefresher } from './lib/dashboard-mv-refresher.js';
import { startFollowUpWorker } from './lib/follow-up-worker.js';
import { startReminderWorker } from './lib/reminder-worker.js';
import { startReactivationWorker } from './lib/reactivation-worker.js';
import { startSlaAlertWorker } from './lib/sla-alert-worker.js';
import { startCardValidationWorker } from './lib/card-validation-worker.js';
import { startStaleReplyMonitor } from './lib/stale-reply-monitor.js';
import { startJudgeWorker } from './lib/judge-worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.resolve(__dirname, '../../docs');

interface RawBodyRequest extends express.Request {
  rawBody?: Buffer;
}

async function main(): Promise<void> {
  const app = express();

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        const allowed = env.FRONTEND_ORIGIN.includes(origin);
        if (!allowed) {
          logger.warn(
            { origin, allowedOrigins: env.FRONTEND_ORIGIN },
            'CORS: origin bloqueado — verifique FRONTEND_ORIGIN no .env',
          );
        }
        return cb(null, allowed);
      },
      credentials: true,
    }),
  );

  app.use(cookieParser());

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        const url = (req as express.Request).url ?? '';
        if (url.includes('/webhooks/') && url.endsWith('/meta')) {
          (req as RawBodyRequest).rawBody = Buffer.from(buf);
        }
      },
    }),
  );

  app.use((req, _res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'http');
    next();
  });

  app.use('/api', apiRouter);

  app.use('/docs', express.static(DOCS_DIR, { extensions: ['html'] }));

  await getCheckpointer();

  try {
    const def = await ensureDefaultUnit();
    logger.info({ id: def.id, slug: def.slug }, 'Unit default disponível');
  } catch (err) {
    logger.warn({ err }, 'falha ao semear Unit default — webhooks legados podem falhar');
  }

  startWhatsappCostScheduler();

  startDashboardMvRefresher();

  startStaleReplyMonitor();
  startJudgeWorker();
  startFollowUpWorker();
  startReminderWorker();
  startReactivationWorker();
  startSlaAlertWorker();
  startCardValidationWorker();

  const server = app.listen(env.PORT, () => {
    logger.info(`Backend ouvindo em http://localhost:${env.PORT}`);
    logger.info(`Webhook URL → POST http://localhost:${env.PORT}/api/webhooks/{slug}/{kommo|salesbot|meta}`);
    logger.info(`Documentação → http://localhost:${env.PORT}/docs`);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown iniciado');
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'boot falhou');
  process.exit(1);
});
