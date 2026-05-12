// ============================================================================
// api.routes.ts — Roteamento HTTP.
//
// Mantemos os routers separados do server.ts pra facilitar testes
// (instanciar router isolado com supertest) e pra deixar claro o
// "contrato HTTP" da aplicação.
// ============================================================================

import { Router } from 'express';
import { handleKommoWebhook } from '../controllers/webhook.controller.js';
import { listTraces, getTrace, getStats } from '../controllers/traces.controller.js';
import { getConfig, putConfig } from '../controllers/config.controller.js';

export const apiRouter = Router();

// Webhook do Kommo — entrada principal.
apiRouter.post('/webhooks/kommo', handleKommoWebhook);

// API consumida pelo dashboard React.
apiRouter.get('/traces', listTraces);
apiRouter.get('/traces/:id', getTrace);
apiRouter.get('/stats', getStats);

// Configuração do agente — prompt, tools e sequências.
apiRouter.get('/config', getConfig);
apiRouter.put('/config', putConfig);

// Health check (útil em K8s).
apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});
