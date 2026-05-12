// ============================================================================
// server.ts — Entry point HTTP.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Boot do servidor Express com:
//   - CORS restrito à origem do dashboard (FRONTEND_ORIGIN).
//   - Body parser JSON + urlencoded (Kommo manda urlencoded por padrão).
//   - Logger via Pino.
//   - Setup do PostgresSaver no boot (não na primeira request — failfast).
//
// Graceful shutdown: capturamos SIGTERM/SIGINT pra fechar conexões TCP do
// Prisma e do Saver. Sem isso, o Kubernetes mata o pod no meio de uma
// query e logs aparecem como erros aleatórios em rolling deploy.
// ============================================================================

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { apiRouter } from './routes/api.routes.js';
import { getCheckpointer } from './agent/graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// backend/src/server.ts -> raiz do projeto: ../../
const DOCS_DIR = path.resolve(__dirname, '../../docs');

async function main(): Promise<void> {
  const app = express();

  // CORS — env.FRONTEND_ORIGIN é uma lista (string[]). O cors package
  // aceita array e libera só o que bater. Requests sem header Origin
  // (curl, server-to-server) são permitidas — útil pro webhook do Kommo
  // e pro health check.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        const allowed = env.FRONTEND_ORIGIN.includes(origin);
        return cb(null, allowed);
      },
      credentials: false,
    }),
  );

  // Webhooks do Kommo chegam como x-www-form-urlencoded com chaves aninhadas
  // (leads[add][0][id]). `extended: true` ativa o parser `qs` que expande
  // essas chaves para objeto/array.
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Log mínimo de cada request — útil em dev. Em prod use pino-http.
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'http');
    next();
  });

  app.use('/api', apiRouter);

  // Documentação web — servida em /docs (mesmo host do backend).
  // Funciona tanto em dev quanto em produção. Em dev o Vite proxia /api para
  // este backend; /docs também pode ser acessado direto aqui.
  app.use('/docs', express.static(DOCS_DIR, { extensions: ['html'] }));

  // Inicializa checkpointer (cria tabelas do LangGraph se necessário).
  await getCheckpointer();

  const server = app.listen(env.PORT, () => {
    logger.info(`Backend ouvindo em http://localhost:${env.PORT}`);
    logger.info(`Webhook URL → POST http://localhost:${env.PORT}/api/webhooks/kommo`);
    logger.info(`Documentação → http://localhost:${env.PORT}/docs`);
  });

  // Graceful shutdown.
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
