import { prisma } from '../lib/prisma.js';
import { Router } from 'express';
import { handleKommoWebhook } from '../controllers/webhook.controller.js';
import { sessionStatsHandler } from '../controllers/session-stats.controller.js';
import { resultadosHandler, recalcularResultadosHandler } from '../controllers/resultados.controller.js';
import { slaReportHandler } from '../controllers/sla-report.controller.js';
import { handleSalesbotWebhook } from '../controllers/salesbot.controller.js';
import { handleWidgetRequest } from '../controllers/widget.controller.js';
import { handleMetaVerify, handleMetaWebhook } from '../controllers/meta.controller.js';
import { listTraces, getTrace, getStats } from '../controllers/traces.controller.js';
import { listSystemLogs, listSystemLogModules } from '../controllers/logs.controller.js';
import { getConfig, putConfig, getFlattenedPrompt } from '../controllers/config.controller.js';
import {
  listUnitsHandler,
  getUnitHandler,
  createUnitHandler,
  updateUnitHandler,
  deleteUnitHandler,
  cloneUnitHandler,
  unitStatsHandler,
  kommoPipelinesHandler,
  kommoValidateHandler,
  kommoFieldsHandler,
  kommoSalesbotsHandler,
  kommoTagsHandler,
  kommoUsersHandler,
  kommoLossReasonsHandler,
  widgetStatusHandler,
  previewPromptHandler,
  dashboardHandler,
  dashboardAggregateHandler,
  leadsBucketHandler,
  metaValidateHandler,
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
  listGlobalActionsHandler,
  createGlobalActionHandler,
  updateGlobalActionHandler,
  deleteGlobalActionHandler,
} from '../controllers/global-actions.controller.js';
import {
  reportConversationsHandler,
  reportLlmCostHandler,
  reportActionsHandler,
  reportErrorsHandler,
  reportWhatsappCostHandler,
} from '../controllers/reports.controller.js';
import {
  listLeadFieldRulesHandler,
  createLeadFieldRuleHandler,
  updateLeadFieldRuleHandler,
  deleteLeadFieldRuleHandler,
  listKommoLeadCustomFieldsHandler,
  captureCoverageHandler,
} from '../controllers/lead-field-rules.controller.js';
import {
  handleInstagramVerify,
  handleInstagramWebhook,
  listInstagramCommentsHandler,
  approveInstagramCommentHandler,
  rejectInstagramCommentHandler,
} from '../controllers/instagram.controller.js';
import {
  listFollowUpRulesHandler,
  upsertFollowUpRuleHandler,
  toggleFollowUpHandler,
} from '../controllers/follow-up.controller.js';
import {
  emergencyPauseHandler,
  resumeHandler,
  spineStatusHandler,
  updateReminderHandler,
  spineSchedulesHandler,
  spinePingHandler,
  confirmScheduleHandler,
  biLeadsSourcesHandler,
  createAgendaBlockHandler,
  deleteAgendaBlockHandler,
  createAgendaBlockBulkHandler,
  deleteAgendaBlockBulkHandler,
  listAgendaBlocksHandler,
  syncLeadHandler,
  listLeadLinksHandler,
  previewLeadHandler,
  prontidaoHandler,
  pendentesHandler,
  previewPatientHandler,
  syncPatientHandler,
  cancelScheduleHandler,
} from '../controllers/spine.controller.js';
import {
  getAlerts,
  getIntegrations,
  getDeliveryMonitor,
} from '../controllers/integrations.controller.js';
import {
  getWhatsappCostsHandler,
  getWhatsappTemplatesHandler,
  syncWhatsappCostsHandler,
} from '../controllers/whatsapp-costs.controller.js';
import {
  getPromptPerformanceHandler,
  getConversationEvaluationHandler,
  reEvaluateConversationHandler,
  openaiDebugHandler,
} from '../controllers/prompts.controller.js';
import { loginHandler, logoutHandler, meHandler } from '../controllers/auth.controller.js';
import { playgroundRunHandler } from '../controllers/playground.controller.js';
import { saudeIaHandler } from '../controllers/saude-ia.controller.js';
import { listChangeLogHandler } from '../controllers/change-log.controller.js';
import {
  listLessonsHandler,
  createLessonHandler,
  updateLessonHandler,
  deleteLessonHandler,
  reflectLessonsHandler,
} from '../controllers/lessons.controller.js';
import {
  runStrategyLabHandler,
  chooseStrategyHandler,
} from '../controllers/strategy-lab.controller.js';
import {
  listKnowledgeLinksHandler,
  createKnowledgeLinkHandler,
  reprocessKnowledgeLinkHandler,
  deleteKnowledgeLinkHandler,
} from '../controllers/knowledge-links.controller.js';
import {
  listUsersHandler,
  createUserHandler,
  updateUserHandler,
  deleteUserHandler,
} from '../controllers/users.controller.js';
import { KommoService } from '../services/kommo.service.js';
import { requireAuth, requireSuperAdmin, requireUnitAccess } from '../middleware/auth.js';
import { rodarDiagnostico } from '../services/diagnostics.service.js';
import { apiReference } from '@scalar/express-api-reference';
import { gerarOpenApi } from '../docs/openapi.js';

export const apiRouter = Router();

apiRouter.post('/webhooks/:unitSlug/kommo', handleKommoWebhook);
apiRouter.post('/webhooks/:unitSlug/salesbot', handleSalesbotWebhook);
apiRouter.post('/webhooks/:unitSlug/widget', handleWidgetRequest);
apiRouter.get('/webhooks/:unitSlug/meta', handleMetaVerify);
apiRouter.post('/webhooks/:unitSlug/meta', handleMetaWebhook);
apiRouter.get('/webhooks/:unitSlug/instagram', handleInstagramVerify);
apiRouter.post('/webhooks/:unitSlug/instagram', handleInstagramWebhook);
apiRouter.get('/webhooks/:unitSlug/facebook', handleInstagramVerify);
apiRouter.post('/webhooks/:unitSlug/facebook', handleInstagramWebhook);
apiRouter.post('/webhooks/kommo', handleKommoWebhook);
apiRouter.post('/webhooks/salesbot', handleSalesbotWebhook);

apiRouter.get('/integrations/:unitSlug/session-stats/:leadId', sessionStatsHandler);
apiRouter.get('/integrations/sla-report', slaReportHandler);

apiRouter.get('/debug/diagnostico', requireAuth, requireSuperAdmin, async (_req, res) => {
  try {
    res.json(await rodarDiagnostico());
  } catch (err) {
    res.status(500).json({ error: 'diagnostico_falhou', message: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.get('/openapi.json', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/api`;
  res.json(gerarOpenApi(apiRouter, base));
});

apiRouter.get(
  '/docs',
  apiReference({
    url: '/api/openapi.json',
    theme: 'purple',
    pageTitle: 'API do Agente DT',
  }),
);

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * Prontidão de verdade, para quem orquestra decidir se manda tráfego.
 *
 * O /health acima responde "ok" mesmo com o Postgres fora — ele diz só que o
 * processo está de pé. Isso já basta pra liveness (reiniciar travado), mas
 * mentia como readiness: o contêiner recebia tráfego sem conseguir atender.
 *
 * Aqui o banco é tocado de verdade. Fica sem autenticação de propósito — probe
 * de orquestrador não faz login — e por isso não devolve detalhe nenhum além do
 * necessário: 200 ou 503, sem versão, sem topologia, sem mensagem de erro do
 * driver, que seria entregar mapa da infraestrutura pra quem só chamou uma URL.
 */
apiRouter.get('/health/ready', async (_req, res) => {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, banco: 'ok', ms: Date.now() - t0 });
  } catch {
    res.status(503).json({ ok: false, banco: 'fora', ms: Date.now() - t0 });
  }
});

apiRouter.post('/auth/login', loginHandler);

apiRouter.use(requireAuth);

apiRouter.get('/auth/me', meHandler);
apiRouter.post('/auth/logout', logoutHandler);

apiRouter.get('/units', listUnitsHandler);
apiRouter.post('/units', requireSuperAdmin, createUnitHandler);
apiRouter.post('/units/:id/clone', requireSuperAdmin, cloneUnitHandler);
apiRouter.delete('/units/:id', requireSuperAdmin, deleteUnitHandler);

apiRouter.get('/units/:id', requireUnitAccess, getUnitHandler);
apiRouter.patch('/units/:id', requireUnitAccess, updateUnitHandler);
apiRouter.get('/units/:id/stats', requireUnitAccess, unitStatsHandler);
// Livro de resultados: o que a IA fez por conversa e o que aconteceu depois (Kommo + franquia).
apiRouter.get('/units/:id/resultados', requireUnitAccess, resultadosHandler);
apiRouter.post('/units/:id/resultados/recalcular', requireUnitAccess, recalcularResultadosHandler);
apiRouter.get('/units/:id/dashboard', requireUnitAccess, dashboardHandler);
apiRouter.get('/units/:id/leads-bucket', requireUnitAccess, leadsBucketHandler);
apiRouter.get('/units/:id/integrations', requireUnitAccess, getIntegrations);
apiRouter.get('/units/:id/whatsapp-costs', requireUnitAccess, getWhatsappCostsHandler);
apiRouter.get('/units/:id/whatsapp-templates', requireUnitAccess, getWhatsappTemplatesHandler);
apiRouter.post('/units/:id/whatsapp-costs/sync', requireUnitAccess, syncWhatsappCostsHandler);
apiRouter.get('/units/:id/openai-debug', requireUnitAccess, openaiDebugHandler);
apiRouter.get('/units/:id/prompt-performance', requireUnitAccess, getPromptPerformanceHandler);
apiRouter.get('/units/:id/flagged-messages', requireUnitAccess, listFlaggedMessagesHandler);
apiRouter.post('/units/:id/preview-prompt', requireUnitAccess, previewPromptHandler);
apiRouter.post('/units/:id/playground/run', requireUnitAccess, playgroundRunHandler);

apiRouter.get('/units/:id/kommo-pipelines', requireUnitAccess, kommoPipelinesHandler);
apiRouter.get('/units/:id/kommo-fields', requireUnitAccess, kommoFieldsHandler);
apiRouter.get('/units/:id/kommo-salesbots', requireUnitAccess, kommoSalesbotsHandler);
apiRouter.get('/units/:id/kommo-tags', requireUnitAccess, kommoTagsHandler);
apiRouter.get('/units/:id/kommo-users', requireUnitAccess, kommoUsersHandler);
apiRouter.get('/units/:id/kommo-loss-reasons', requireUnitAccess, kommoLossReasonsHandler);
apiRouter.post('/units/:id/kommo-validate', requireUnitAccess, kommoValidateHandler);
apiRouter.post('/units/:id/meta-validate', requireUnitAccess, metaValidateHandler);
apiRouter.get('/units/:id/widget-status', requireUnitAccess, widgetStatusHandler);

apiRouter.get('/units/:id/templates', requireUnitAccess, listTemplatesHandler);
apiRouter.post('/units/:id/templates', requireUnitAccess, createTemplateHandler);
apiRouter.patch('/units/:id/templates/:templateId', requireUnitAccess, updateTemplateHandler);
apiRouter.delete('/units/:id/templates/:templateId', requireUnitAccess, deleteTemplateHandler);

apiRouter.get('/units/:id/changelog', requireUnitAccess, listChangeLogHandler);
apiRouter.get('/units/:id/lessons', requireUnitAccess, listLessonsHandler);
apiRouter.post('/units/:id/lessons', requireUnitAccess, createLessonHandler);
apiRouter.post('/units/:id/lessons/reflect', requireUnitAccess, reflectLessonsHandler);
apiRouter.post('/units/:id/strategy-lab', requireUnitAccess, runStrategyLabHandler);
apiRouter.post('/units/:id/strategy-lab/:runId/escolher', requireUnitAccess, chooseStrategyHandler);
apiRouter.get('/units/:id/knowledge-links', requireUnitAccess, listKnowledgeLinksHandler);
apiRouter.post('/units/:id/knowledge-links', requireUnitAccess, createKnowledgeLinkHandler);
apiRouter.post('/units/:id/knowledge-links/:linkId/processar', requireUnitAccess, reprocessKnowledgeLinkHandler);
apiRouter.delete('/units/:id/knowledge-links/:linkId', requireUnitAccess, deleteKnowledgeLinkHandler);
apiRouter.patch('/units/:id/lessons/:lessonId', requireUnitAccess, updateLessonHandler);
apiRouter.delete('/units/:id/lessons/:lessonId', requireUnitAccess, deleteLessonHandler);
apiRouter.get('/units/:id/knowledge', requireUnitAccess, listKnowledgeHandler);
apiRouter.post('/units/:id/knowledge', requireUnitAccess, createKnowledgeHandler);
apiRouter.patch('/units/:id/knowledge/:entryId', requireUnitAccess, updateKnowledgeHandler);
apiRouter.delete('/units/:id/knowledge/:entryId', requireUnitAccess, deleteKnowledgeHandler);

apiRouter.get('/units/:id/actions', requireUnitAccess, listActionsHandler);
apiRouter.post('/units/:id/actions', requireUnitAccess, createActionHandler);
apiRouter.patch('/units/:id/actions/:actionId', requireUnitAccess, updateActionHandler);
apiRouter.delete('/units/:id/actions/:actionId', requireUnitAccess, deleteActionHandler);

apiRouter.get('/global-actions', requireSuperAdmin, listGlobalActionsHandler);
apiRouter.post('/global-actions', requireSuperAdmin, createGlobalActionHandler);
apiRouter.patch('/global-actions/:actionId', requireSuperAdmin, updateGlobalActionHandler);
apiRouter.delete('/global-actions/:actionId', requireSuperAdmin, deleteGlobalActionHandler);

apiRouter.get('/reports/conversations', reportConversationsHandler);
apiRouter.get('/reports/llm-cost', reportLlmCostHandler);
apiRouter.get('/reports/actions', reportActionsHandler);
apiRouter.get('/reports/errors', reportErrorsHandler);
apiRouter.get('/reports/whatsapp-cost', reportWhatsappCostHandler);

apiRouter.get('/units/:id/lead-field-rules', requireUnitAccess, listLeadFieldRulesHandler);
apiRouter.get(
  '/units/:id/lead-field-rules/coverage',
  requireUnitAccess,
  captureCoverageHandler,
);
apiRouter.post('/units/:id/lead-field-rules', requireUnitAccess, createLeadFieldRuleHandler);
apiRouter.patch('/units/:id/lead-field-rules/:ruleId', requireUnitAccess, updateLeadFieldRuleHandler);
apiRouter.delete('/units/:id/lead-field-rules/:ruleId', requireUnitAccess, deleteLeadFieldRuleHandler);

apiRouter.get('/units/:id/instagram/comments', requireUnitAccess, listInstagramCommentsHandler);
apiRouter.post(
  '/units/:id/instagram/comments/:commentRowId/approve',
  requireUnitAccess,
  approveInstagramCommentHandler,
);
apiRouter.post(
  '/units/:id/instagram/comments/:commentRowId/reject',
  requireUnitAccess,
  rejectInstagramCommentHandler,
);

apiRouter.post('/system/emergency-pause', requireAuth, emergencyPauseHandler);
apiRouter.post('/system/resume', requireAuth, resumeHandler);
apiRouter.get('/units/:id/follow-up/rules', requireUnitAccess, listFollowUpRulesHandler);
apiRouter.post('/units/:id/follow-up/rules', requireUnitAccess, upsertFollowUpRuleHandler);
apiRouter.post('/units/:id/follow-up/toggle', requireUnitAccess, toggleFollowUpHandler);

apiRouter.get('/units/:id/saude-ia', requireUnitAccess, saudeIaHandler);
apiRouter.get('/units/:id/spine/status', requireUnitAccess, spineStatusHandler);
apiRouter.patch('/units/:id/spine/reminder', requireUnitAccess, updateReminderHandler);
apiRouter.get('/units/:id/spine/schedules', requireUnitAccess, spineSchedulesHandler);
apiRouter.post('/units/:id/spine/ping', requireUnitAccess, spinePingHandler);
apiRouter.post('/units/:id/spine/sync-lead', requireUnitAccess, syncLeadHandler);
apiRouter.get('/units/:id/spine/lead-links', requireUnitAccess, listLeadLinksHandler);
apiRouter.post('/units/:id/spine/lead-preview', requireUnitAccess, previewLeadHandler);
apiRouter.get('/units/:id/spine/prontidao', requireUnitAccess, prontidaoHandler);
apiRouter.get('/units/:id/spine/pendentes', requireUnitAccess, pendentesHandler);
apiRouter.post('/units/:id/spine/patient-preview', requireUnitAccess, previewPatientHandler);
apiRouter.post('/units/:id/spine/sync-patient', requireUnitAccess, syncPatientHandler);
apiRouter.post('/units/:id/spine/cancel-schedule', requireUnitAccess, cancelScheduleHandler);
apiRouter.post('/units/:id/spine/confirm-schedule', requireUnitAccess, confirmScheduleHandler);
apiRouter.get('/units/:id/spine/bi/leads-sources', requireUnitAccess, biLeadsSourcesHandler);
apiRouter.post('/units/:id/agenda/blocks', requireUnitAccess, createAgendaBlockHandler);
apiRouter.get('/units/:id/agenda/blocks', requireUnitAccess, listAgendaBlocksHandler);
apiRouter.post('/units/:id/agenda/blocks/bulk', requireUnitAccess, createAgendaBlockBulkHandler);
apiRouter.delete('/units/:id/agenda/blocks/bulk', requireUnitAccess, deleteAgendaBlockBulkHandler);
apiRouter.delete('/units/:id/agenda/blocks/:blockId', requireUnitAccess, deleteAgendaBlockHandler);
apiRouter.get('/units/:id/kommo-lead-custom-fields', requireUnitAccess, listKommoLeadCustomFieldsHandler);

apiRouter.get('/traces', listTraces);
apiRouter.get('/traces/:id', getTrace);
apiRouter.get('/stats', getStats);
apiRouter.get('/dashboard', dashboardAggregateHandler);
apiRouter.get('/system-logs', listSystemLogs);
apiRouter.get('/system-logs/modules', listSystemLogModules);
apiRouter.get('/llm-calls', listLlmCallsHandler);
apiRouter.get('/llm-calls/:id', getLlmCallHandler);
apiRouter.get('/conversations', listConversationsHandler);
apiRouter.get('/conversations/:id', getConversationHandler);
apiRouter.patch('/messages/:messageId/flag', flagMessageHandler);
apiRouter.get('/conversations/:id/evaluation', getConversationEvaluationHandler);
apiRouter.post('/conversations/:id/evaluate', reEvaluateConversationHandler);

apiRouter.get('/config', getConfig);
apiRouter.get('/config/flatten', getFlattenedPrompt);
apiRouter.put('/config', putConfig);

apiRouter.get('/alerts', requireSuperAdmin, getAlerts);

apiRouter.get('/delivery-monitor', requireSuperAdmin, getDeliveryMonitor);

apiRouter.get('/users', requireSuperAdmin, listUsersHandler);
apiRouter.post('/users', requireSuperAdmin, createUserHandler);
apiRouter.patch('/users/:id', requireSuperAdmin, updateUserHandler);
apiRouter.delete('/users/:id', requireSuperAdmin, deleteUserHandler);

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

apiRouter.post('/admin/clear-cache', requireAuth, async (_req, res) => {
  const { clearAllConfigCache } = await import('../agent/config.js');
  const { clearAllUnitCache } = await import('../services/units.service.js');
  const { clearDedupCache } = await import('../lib/dedup-cache.js');
  const configCleared = clearAllConfigCache();
  const unitCleared = clearAllUnitCache();
  const dedupCleared = clearDedupCache();
  res.json({
    ok: true,
    cleared: {
      configCache: configCleared,
      unitBySlugCache: unitCleared.slug,
      unitByIdCache: unitCleared.id,
      dedupCache: dedupCleared,
    },
  });
});
