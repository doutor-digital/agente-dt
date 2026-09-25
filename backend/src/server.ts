import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { apiRouter } from './routes/api.routes.js';
import { paginaPausaHandler } from './controllers/pausa.controller.js';
import { paginaAltaHandler } from './controllers/alta.controller.js';
import { getCheckpointer } from './agent/graph.js';
import { ensureDefaultUnit } from './services/units.service.js';
import { startWhatsappCostScheduler, stopWhatsappCostScheduler } from './lib/whatsapp-cost-scheduler.js';
import { startDashboardMvRefresher, stopDashboardMvRefresher } from './lib/dashboard-mv-refresher.js';
import { startFollowUpWorker, stopFollowUpWorker } from './lib/follow-up-worker.js';
import { startReminderWorker, stopReminderWorker } from './lib/reminder-worker.js';
import { startReactivationWorker, stopReactivationWorker } from './lib/reactivation-worker.js';
import { startSlaAlertWorker, stopSlaAlertWorker } from './lib/sla-alert-worker.js';
import { startAgendamentoPerdidoWorker, stopAgendamentoPerdidoWorker } from './lib/agendamento-perdido-worker.js';
import { startTaxaErroWorker, stopTaxaErroWorker } from './lib/taxa-erro-worker.js';
import { startCardValidationWorker, stopCardValidationWorker } from './lib/card-validation-worker.js';
import { startStaleReplyMonitor } from './lib/stale-reply-monitor.js';
import { startJudgeWorker, stopJudgeWorker } from './lib/judge-worker.js';
import { startResultadosWorker, stopResultadosWorker } from './lib/resultados-worker.js';
import { iniciarSupervisorDosWorkers, encerrarSupervisorDosWorkers } from './lib/worker-lease.js';
import { startVozSessaoWorker, stopVozSessaoWorker } from './lib/voz-sessao-worker.js';
import { iniciarVigiaDeQualidade, pararVigiaDeQualidade } from './lib/qualidade-numero-worker.js';
import { startCacheKeepaliveWorker, stopCacheKeepaliveWorker } from './lib/cache-keepalive-worker.js';
import { startParadosWorker, stopParadosWorker } from './lib/parados-worker.js';
import { startNaoLidasWorker, stopNaoLidasWorker } from './lib/nao-lidas-worker.js';
import { startFranquiaSyncWorker, stopFranquiaSyncWorker } from './lib/franquia-sync-worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.resolve(__dirname, '../../docs');

interface RawBodyRequest extends express.Request {
  rawBody?: Buffer;
}

async function main(): Promise<void> {
  const app = express();

  // Widgets privados do Kommo rodam em https://<conta>.kommo.com e chamam SÓ as rotas /api/public/*
  // (agenda da franquia com chave por unidade, pausa com código). Pra elas o CORS libera o Kommo
  // SEM credenciais — o cookie de sessão do painel é SameSite=None e não pode viajar pra lá.
  const ORIGEM_KOMMO = /^https:\/\/[a-z0-9-]+\.(kommo\.com|amocrm\.(com|ru))$/i;
  // O dashboard (Vercel) também consome /api/public/*: a fila de alta mora aqui,
  // mas quem decide é a recepção, e ela já abre o dashboard todo dia. Página solta
  // é mais um endereço pra lembrar — em 2 dias no ar, 170 pacientes na fila e zero
  // decisões. Segue SEM credenciais: a autorização é o código da unidade no corpo
  // da chamada, não o cookie.
  const ORIGEM_DASHBOARD = /^https:\/\/([a-z0-9-]+\.)*doutordigitalconsultoria\.com$/i;
  app.use(
    cors((req, cb) => {
      const origin = req.header('Origin');
      if (!origin) return cb(null, { origin: true, credentials: true });
      if (req.path.startsWith('/api/public/') && (ORIGEM_KOMMO.test(origin) || ORIGEM_DASHBOARD.test(origin))) {
        return cb(null, { origin: true, credentials: false, allowedHeaders: ['Content-Type', 'X-Widget-Key', 'X-Requested-With'], methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] });
      }
      const allowed = env.FRONTEND_ORIGIN.includes(origin);
      if (!allowed) {
        logger.warn(
          { origin, allowedOrigins: env.FRONTEND_ORIGIN },
          'CORS: origin bloqueado — verifique FRONTEND_ORIGIN no .env',
        );
      }
      return cb(null, { origin: allowed, credentials: true });
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

  // Página da recepção para pausar a Sofia por um tempo (protegida por código da unidade).
  app.get('/pausa/:slug', paginaPausaHandler);

  // Página da recepção para aprovar alta e marcar quem parou no meio.
  app.get('/alta/:slug', paginaAltaHandler);
  app.use('/api', apiRouter);

  app.use('/docs', express.static(DOCS_DIR, { extensions: ['html'] }));

  await getCheckpointer();

  try {
    const def = await ensureDefaultUnit();
    logger.info({ id: def.id, slug: def.slug }, 'Unit default disponível');
  } catch (err) {
    logger.warn({ err }, 'falha ao semear Unit default — webhooks legados podem falhar');
  }

  // Por processo: vigia respostas pendentes que ESTE processo prometeu entregar.
  startStaleReplyMonitor();

  // Um líder só. Em 04/09/2026 dois containers rodaram lado a lado por 18 h e
  // cada follow-up saiu duas vezes (148 pacientes). Quem detém o lease no banco
  // roda os workers; o outro processo espera — inclusive na janela do deploy.
  await iniciarSupervisorDosWorkers({
    iniciar: () => {
      startWhatsappCostScheduler();
      startDashboardMvRefresher();
      startJudgeWorker();
      startFollowUpWorker();
      startReminderWorker();
      startReactivationWorker();
      startSlaAlertWorker();
      startAgendamentoPerdidoWorker();
      startTaxaErroWorker();
      startCardValidationWorker();
      startResultadosWorker();
      startVozSessaoWorker();
      startCacheKeepaliveWorker();
      startFranquiaSyncWorker();
      startParadosWorker();
      startNaoLidasWorker();
      iniciarVigiaDeQualidade();
    },
    parar: () => {
      pararVigiaDeQualidade();
      stopParadosWorker();
      stopNaoLidasWorker();
      stopFranquiaSyncWorker();
      stopCacheKeepaliveWorker();
      stopWhatsappCostScheduler();
      stopDashboardMvRefresher();
      stopJudgeWorker();
      stopFollowUpWorker();
      stopReminderWorker();
      stopReactivationWorker();
      stopSlaAlertWorker();
      stopAgendamentoPerdidoWorker();
      stopTaxaErroWorker();
      stopCardValidationWorker();
      stopResultadosWorker();
      stopVozSessaoWorker();
    },
  });

  const server = app.listen(env.PORT, () => {
    logger.info(`Backend ouvindo em http://localhost:${env.PORT}`);
    logger.info(`Webhook URL → POST http://localhost:${env.PORT}/api/webhooks/{slug}/{kommo|salesbot|meta}`);
    logger.info(`Documentação → http://localhost:${env.PORT}/docs`);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown iniciado');
    server.close();
    // Solta o lease antes de desconectar: o container novo assume em ≤30 s.
    await encerrarSupervisorDosWorkers();
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
