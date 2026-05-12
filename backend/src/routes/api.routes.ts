// ============================================================================
// api.routes.ts — Roteamento HTTP.
//
// Mantemos os routers separados do server.ts pra facilitar testes
// (instanciar router isolado com supertest) e pra deixar claro o
// "contrato HTTP" da aplicação.
// ============================================================================

import { Router } from 'express';
import { handleKommoWebhook } from '../controllers/webhook.controller.js';
import { handleSalesbotWebhook } from '../controllers/salesbot.controller.js';
import { listTraces, getTrace, getStats } from '../controllers/traces.controller.js';
import { getConfig, putConfig } from '../controllers/config.controller.js';
import { KommoService } from '../services/kommo.service.js';

export const apiRouter = Router();

// Webhook genérico do Kommo (eventos de CRM) — ACK rápido, agente async.
apiRouter.post('/webhooks/kommo', handleKommoWebhook);

// Webhook do Salesbot (chat conversacional) — SÍNCRONO, devolve reply no body.
apiRouter.post('/webhooks/salesbot', handleSalesbotWebhook);

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

// Endpoints de debug pra descobrir IDs do Kommo sem precisar caçar na UI.
// Filtramos a resposta pra mostrar só nome+id, fica mais legível no navegador.
apiRouter.get('/admin/kommo-fields', async (_req, res) => {
  try {
    const raw = (await KommoService.listLeadCustomFields()) as {
      _embedded?: { custom_fields?: Array<{ id: number; name: string; type: string }> };
    };
    const fields = (raw?._embedded?.custom_fields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
    }));
    res.json({ ok: true, fields });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

apiRouter.get('/admin/kommo-salesbots', async (_req, res) => {
  try {
    const raw = (await KommoService.listSalesbots()) as {
      _embedded?: { salesbot?: Array<{ id: number; name: string }> };
    };
    const bots = (raw?._embedded?.salesbot ?? []).map((b) => ({ id: b.id, name: b.name }));
    res.json({ ok: true, bots });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});
