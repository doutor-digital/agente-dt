// ============================================================================
// server.ts — Entry point HTTP.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Boot do servidor Express com:
//   - CORS restrito à origem do dashboard (FRONTEND_ORIGIN, lista).
//   - Body parser JSON + urlencoded (Kommo manda urlencoded por padrão).
//   - RAW body preservado nas rotas /webhooks/:slug/meta — necessário pra
//     validar a signature HMAC-SHA256 da Meta byte-a-byte.
//   - Logger via Pino.
//   - Setup do PostgresSaver (LangGraph) no boot — failfast.
//   - Seed da Unit default a partir do .env (retrocompat dos webhooks legados).
//
// Graceful shutdown: SIGTERM/SIGINT pra fechar conexões TCP. Sem isso o
// Kubernetes mata o pod no meio de uma query e logs aparecem como erros.
// ============================================================================

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.resolve(__dirname, '../../docs');

// Tipo para preservar raw body (usado pela validação de signature da Meta).
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
        return cb(null, allowed);
      },
      // true: o cookie `dt_session` (httpOnly) circula entre o frontend
      // (porta 5173 ou domínio prod) e a API. Sem isso o login não persiste.
      credentials: true,
    }),
  );

  // Cookie parser — popula req.cookies pro middleware de auth.
  app.use(cookieParser());

  // Body parser urlencoded (webhooks Kommo).
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Body parser JSON com `verify` que captura o RAW body — só é guardado
  // pras rotas Meta. Deixar isso global é aceitável, custo é uma referência
  // ao buffer já alocado pelo express.json.
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

  // Documentação web — servida em /docs.
  app.use('/docs', express.static(DOCS_DIR, { extensions: ['html'] }));

  // Inicializa checkpointer (cria tabelas do LangGraph se necessário).
  await getCheckpointer();

  // Garante que a Unit default existe — retrocompat com webhooks legados.
  try {
    const def = await ensureDefaultUnit();
    logger.info({ id: def.id, slug: def.slug }, 'Unit default disponível');
  } catch (err) {
    logger.warn({ err }, 'falha ao semear Unit default — webhooks legados podem falhar');
  }

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
