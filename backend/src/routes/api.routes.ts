// ============================================================================
// api.routes.ts — Roteamento HTTP (multi-tenant).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Webhooks são versionados por Unit via slug na URL:
//   /api/webhooks/:unitSlug/{kommo|salesbot|meta}
//
// As rotas legadas (sem slug) permanecem por retrocompat — caem na "default
// unit" semeada do .env no boot.
//
// API admin (CRUD de Unit, observabilidade) NÃO tem auth no MVP — está no
// roadmap. Rodar atrás de VPN.
// ============================================================================

import { Router } from 'express';
import { handleKommoWebhook } from '../controllers/webhook.controller.js';
import { handleSalesbotWebhook } from '../controllers/salesbot.controller.js';
import { handleMetaVerify, handleMetaWebhook } from '../controllers/meta.controller.js';
import { listTraces, getTrace, getStats } from '../controllers/traces.controller.js';
import { getConfig, putConfig } from '../controllers/config.controller.js';
import {
  listUnitsHandler,
  getUnitHandler,
  createUnitHandler,
  updateUnitHandler,
  deleteUnitHandler,
  unitStatsHandler,
  kommoPipelinesHandler,
  kommoValidateHandler,
  kommoFieldsHandler,
  kommoSalesbotsHandler,
  kommoTagsHandler,
  previewPromptHandler,
  dashboardHandler,
} from '../controllers/units.controller.js';
import {
  listLlmCallsHandler,
  getLlmCallHandler,
} from '../controllers/llm-calls.controller.js';
import {
  listConversationsHandler,
  getConversationHandler,
  flagMessageHandler,
  listFlaggedMessagesHandler,
} from '../controllers/conversations.controller.js';
import {
  listTemplatesHandler,
  createTemplateHandler,
  updateTemplateHandler,
  deleteTemplateHandler,
} from '../controllers/templates.controller.js';
import {
  listKnowledgeHandler,
  createKnowledgeHandler,
  updateKnowledgeHandler,
  deleteKnowledgeHandler,
} from '../controllers/knowledge.controller.js';
import {
  listActionsHandler,
  createActionHandler,
  updateActionHandler,
  deleteActionHandler,
} from '../controllers/actions.controller.js';
import {
  googleOAuthStartHandler,
  googleOAuthCallbackHandler,
  googleOAuthDisconnectHandler,
} from '../controllers/google-oauth.controller.js';
import { getAlerts, getIntegrations } from '../controllers/integrations.controller.js';
import {
  getPromptPerformanceHandler,
  getConversationEvaluationHandler,
  reEvaluateConversationHandler,
  openaiDebugHandler,
} from '../controllers/prompts.controller.js';
import { KommoService } from '../services/kommo.service.js';

export const apiRouter = Router();

// ---------------------------------------------------------------------------
// Webhooks — multi-tenant.
// ---------------------------------------------------------------------------
apiRouter.post('/webhooks/:unitSlug/kommo', handleKommoWebhook);
apiRouter.post('/webhooks/:unitSlug/salesbot', handleSalesbotWebhook);
apiRouter.get('/webhooks/:unitSlug/meta', handleMetaVerify);
apiRouter.post('/webhooks/:unitSlug/meta', handleMetaWebhook);

// Retrocompat — caem na default unit (semeada do .env).
apiRouter.post('/webhooks/kommo', handleKommoWebhook);
apiRouter.post('/webhooks/salesbot', handleSalesbotWebhook);

// ---------------------------------------------------------------------------
// Observabilidade — consumida pelo dashboard.
// ---------------------------------------------------------------------------
apiRouter.get('/traces', listTraces);
apiRouter.get('/traces/:id', getTrace);
apiRouter.get('/stats', getStats);
apiRouter.get('/llm-calls', listLlmCallsHandler);
apiRouter.get('/llm-calls/:id', getLlmCallHandler);
apiRouter.get('/conversations', listConversationsHandler);
apiRouter.get('/conversations/:id', getConversationHandler);
apiRouter.patch('/messages/:messageId/flag', flagMessageHandler);
apiRouter.get('/units/:id/flagged-messages', listFlaggedMessagesHandler);

// Templates CRUD
apiRouter.get('/units/:id/templates', listTemplatesHandler);
apiRouter.post('/units/:id/templates', createTemplateHandler);
apiRouter.patch('/units/:id/templates/:templateId', updateTemplateHandler);
apiRouter.delete('/units/:id/templates/:templateId', deleteTemplateHandler);

// Knowledge base (RAG) CRUD
apiRouter.get('/units/:id/knowledge', listKnowledgeHandler);
apiRouter.post('/units/:id/knowledge', createKnowledgeHandler);
apiRouter.patch('/units/:id/knowledge/:entryId', updateKnowledgeHandler);
apiRouter.delete('/units/:id/knowledge/:entryId', deleteKnowledgeHandler);

// Ações (regras "quando → faça") CRUD
apiRouter.get('/units/:id/actions', listActionsHandler);
apiRouter.post('/units/:id/actions', createActionHandler);
apiRouter.patch('/units/:id/actions/:actionId', updateActionHandler);
apiRouter.delete('/units/:id/actions/:actionId', deleteActionHandler);

// Google Calendar OAuth
apiRouter.get('/units/:id/google-oauth/start', googleOAuthStartHandler);
apiRouter.get('/google-oauth/callback', googleOAuthCallbackHandler);
apiRouter.delete('/units/:id/google-oauth', googleOAuthDisconnectHandler);

// ---------------------------------------------------------------------------
// Configuração do agente — prompt, tools e sequências (por Unit).
// ---------------------------------------------------------------------------
apiRouter.get('/config', getConfig);
apiRouter.put('/config', putConfig);

// ---------------------------------------------------------------------------
// CRUD de Units.
// ---------------------------------------------------------------------------
apiRouter.get('/units', listUnitsHandler);
apiRouter.post('/units', createUnitHandler);
apiRouter.get('/units/:id', getUnitHandler);
apiRouter.patch('/units/:id', updateUnitHandler);
apiRouter.delete('/units/:id', deleteUnitHandler);
apiRouter.get('/units/:id/stats', unitStatsHandler);
apiRouter.get('/units/:id/kommo-pipelines', kommoPipelinesHandler);
apiRouter.get('/units/:id/kommo-fields', kommoFieldsHandler);
apiRouter.get('/units/:id/kommo-salesbots', kommoSalesbotsHandler);
apiRouter.get('/units/:id/kommo-tags', kommoTagsHandler);
apiRouter.post('/units/:id/kommo-validate', kommoValidateHandler);
apiRouter.post('/units/:id/preview-prompt', previewPromptHandler);
apiRouter.get('/units/:id/dashboard', dashboardHandler);
apiRouter.get('/units/:id/integrations', getIntegrations);
apiRouter.get('/units/:id/openai-debug', openaiDebugHandler);
apiRouter.get('/units/:id/prompt-performance', getPromptPerformanceHandler);

// Avaliação de uma conversa (LLM-as-judge).
apiRouter.get('/conversations/:id/evaluation', getConversationEvaluationHandler);
apiRouter.post('/conversations/:id/evaluate', reEvaluateConversationHandler);

// ---------------------------------------------------------------------------
// Alertas globais (todas as Units) — usado pelo badge no header.
// ---------------------------------------------------------------------------
apiRouter.get('/alerts', getAlerts);

// ---------------------------------------------------------------------------
// Health + endpoints de debug.
// ---------------------------------------------------------------------------
apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

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
