// ============================================================================
// logger.ts — Logger estruturado (Pino).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Logs estruturados (JSON) em produção e bonitos (pino-pretty) em dev.
// Cada log que escrevemos deve carregar contexto suficiente para correlação:
// `threadId`, `leadId`, `traceId`. Em produção isso permite buscar uma
// execução inteira no Datadog/Loki com um único filtro.
// ============================================================================

import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'agente-dt-backend' },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});
