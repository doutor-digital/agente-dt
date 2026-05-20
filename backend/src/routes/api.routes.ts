// ============================================================================
// api.routes.ts — Roteamento HTTP (multi-tenant + autenticado).
//
// CAMADAS DE AUTORIZAÇÃO
// ----------------------
// 1) ABERTO — webhooks (Kommo/Meta não logam), /health, /auth/google/*.
// 2) requireAuth — qualquer user logado (SUPER_ADMIN ou UNIT_ADMIN).
//    Aplica via apiRouter.use depois das rotas abertas.
// 3) requireSuperAdmin — gestão de Units (criar/apagar) e Users.
// 4) requireUnitAccess — endpoints /units/:id/*: SUPER passa direto,
//    UNIT_ADMIN só se a unit alvo for a dele.
// 5) Endpoints "amplos" (/traces, /llm-calls, /conversations) filtram
//    por role no controller (não confiam no client).
//
// Webhooks ficam ANTES do `requireAuth` global, senão Kommo/Meta levavam 401.
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
  leadsBucketHandler,
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
import { getAlerts, getIntegrations } from '../controllers/integrations.controller.js';
import {
  getPromptPerformanceHandler,
  getConversationEvaluationHandler,
  reEvaluateConversationHandler,
  openaiDebugHandler,
} from '../controllers/prompts.controller.js';
import {
  googleStartHandler,
  googleCallbackHandler,
  logoutHandler,
  meHandler,
} from '../controllers/auth.controller.js';
import {
  listUsersHandler,
  createUserHandler,
  updateUserHandler,
  deleteUserHandler,
} from '../controllers/users.controller.js';
import { KommoService } from '../services/kommo.service.js';
import { requireAuth, requireSuperAdmin, requireUnitAccess } from '../middleware/auth.js';

export const apiRouter = Router();

// ===========================================================================
// 1) ABERTO — nenhum middleware de auth.
// ===========================================================================

// Webhooks externos.
apiRouter.post('/webhooks/:unitSlug/kommo', handleKommoWebhook);
apiRouter.post('/webhooks/:unitSlug/salesbot', handleSalesbotWebhook);
apiRouter.get('/webhooks/:unitSlug/meta', handleMetaVerify);
apiRouter.post('/webhooks/:unitSlug/meta', handleMetaWebhook);
apiRouter.post('/webhooks/kommo', handleKommoWebhook);          // retrocompat
apiRouter.post('/webhooks/salesbot', handleSalesbotWebhook);    // retrocompat

// Health.
apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Login Google — não pode exigir cookie (justamente quem vai ganhar o cookie).
apiRouter.get('/auth/google/start', googleStartHandler);
apiRouter.get('/auth/google/callback', googleCallbackHandler);

// ===========================================================================
// 2) DAQUI PRA BAIXO: TUDO exige sessão válida.
// ===========================================================================

apiRouter.use(requireAuth);

// Auth — me + logout (já passou pelo requireAuth).
apiRouter.get('/auth/me', meHandler);
apiRouter.post('/auth/logout', logoutHandler);

// ---------------------------------------------------------------------------
// CRUD de Units — listar/criar/apagar é só SUPER_ADMIN.
// `listUnitsHandler` filtra internamente: UNIT_ADMIN recebe só sua unit.
// ---------------------------------------------------------------------------
apiRouter.get('/units', listUnitsHandler);                              // filtrado por role no controller
apiRouter.post('/units', requireSuperAdmin, createUnitHandler);
apiRouter.delete('/units/:id', requireSuperAdmin, deleteUnitHandler);

// Leitura/edição de uma unit específica — super OU unit_admin da própria.
apiRouter.get('/units/:id', requireUnitAccess, getUnitHandler);
apiRouter.patch('/units/:id', requireUnitAccess, updateUnitHandler);
apiRouter.get('/units/:id/stats', requireUnitAccess, unitStatsHandler);
apiRouter.get('/units/:id/dashboard', requireUnitAccess, dashboardHandler);
apiRouter.get('/units/:id/leads-bucket', requireUnitAccess, leadsBucketHandler);
apiRouter.get('/units/:id/integrations', requireUnitAccess, getIntegrations);
apiRouter.get('/units/:id/openai-debug', requireUnitAccess, openaiDebugHandler);
apiRouter.get('/units/:id/prompt-performance', requireUnitAccess, getPromptPerformanceHandler);
apiRouter.get('/units/:id/flagged-messages', requireUnitAccess, listFlaggedMessagesHandler);
apiRouter.post('/units/:id/preview-prompt', requireUnitAccess, previewPromptHandler);

// Kommo helpers — UNIT_ADMIN também pode (precisa configurar a própria unit).
apiRouter.get('/units/:id/kommo-pipelines', requireUnitAccess, kommoPipelinesHandler);
apiRouter.get('/units/:id/kommo-fields', requireUnitAccess, kommoFieldsHandler);
apiRouter.get('/units/:id/kommo-salesbots', requireUnitAccess, kommoSalesbotsHandler);
apiRouter.get('/units/:id/kommo-tags', requireUnitAccess, kommoTagsHandler);
apiRouter.post('/units/:id/kommo-validate', requireUnitAccess, kommoValidateHandler);

// Templates / Knowledge / Ações — UNIT_ADMIN edita os da sua unit.
apiRouter.get('/units/:id/templates', requireUnitAccess, listTemplatesHandler);
apiRouter.post('/units/:id/templates', requireUnitAccess, createTemplateHandler);
apiRouter.patch('/units/:id/templates/:templateId', requireUnitAccess, updateTemplateHandler);
apiRouter.delete('/units/:id/templates/:templateId', requireUnitAccess, deleteTemplateHandler);

apiRouter.get('/units/:id/knowledge', requireUnitAccess, listKnowledgeHandler);
apiRouter.post('/units/:id/knowledge', requireUnitAccess, createKnowledgeHandler);
apiRouter.patch('/units/:id/knowledge/:entryId', requireUnitAccess, updateKnowledgeHandler);
apiRouter.delete('/units/:id/knowledge/:entryId', requireUnitAccess, deleteKnowledgeHandler);

apiRouter.get('/units/:id/actions', requireUnitAccess, listActionsHandler);
apiRouter.post('/units/:id/actions', requireUnitAccess, createActionHandler);
apiRouter.patch('/units/:id/actions/:actionId', requireUnitAccess, updateActionHandler);
apiRouter.delete('/units/:id/actions/:actionId', requireUnitAccess, deleteActionHandler);

// ---------------------------------------------------------------------------
// Endpoints "amplos" — o controller força unitId do user (UNIT_ADMIN não
// consegue snifar outras units mesmo passando ?unitId=outra).
// ---------------------------------------------------------------------------
apiRouter.get('/traces', listTraces);
apiRouter.get('/traces/:id', getTrace);
apiRouter.get('/stats', getStats);
apiRouter.get('/llm-calls', listLlmCallsHandler);
apiRouter.get('/llm-calls/:id', getLlmCallHandler);
apiRouter.get('/conversations', listConversationsHandler);
apiRouter.get('/conversations/:id', getConversationHandler);
apiRouter.patch('/messages/:messageId/flag', flagMessageHandler);
apiRouter.get('/conversations/:id/evaluation', getConversationEvaluationHandler);
apiRouter.post('/conversations/:id/evaluate', reEvaluateConversationHandler);

// Config — legado, mantém aberto pra qualquer logado (refactor pendente).
apiRouter.get('/config', getConfig);
apiRouter.put('/config', putConfig);

// Alertas globais — só SUPER_ADMIN faz sentido (agrega múltiplas units).
apiRouter.get('/alerts', requireSuperAdmin, getAlerts);

// ---------------------------------------------------------------------------
// Users CRUD — só SUPER_ADMIN.
// ---------------------------------------------------------------------------
apiRouter.get('/users', requireSuperAdmin, listUsersHandler);
apiRouter.post('/users', requireSuperAdmin, createUserHandler);
apiRouter.patch('/users/:id', requireSuperAdmin, updateUserHandler);
apiRouter.delete('/users/:id', requireSuperAdmin, deleteUserHandler);

// ---------------------------------------------------------------------------
// Endpoints admin do .env (Kommo default) — só SUPER_ADMIN.
// ---------------------------------------------------------------------------
apiRouter.get('/admin/kommo-fields', requireSuperAdmin, async (_req, res) => {
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

apiRouter.get('/admin/kommo-salesbots', requireSuperAdmin, async (_req, res) => {
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
