import { prisma } from '../lib/prisma.js';
import { Router } from 'express';
import { handleKommoWebhook } from '../controllers/webhook.controller.js';
import { sessionStatsHandler } from '../controllers/session-stats.controller.js';
import { resultadosHandler, recalcularResultadosHandler } from '../controllers/resultados.controller.js';
import { funcionamentoHandler } from '../controllers/funcionamento.controller.js';
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
  painelUnidadeHandler,
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
import {
  publicPausarHandler,
  publicRetomarHandler,
  publicStatusHandler,
  publicLeadPausarHandler,
  publicLeadRetomarHandler,
  publicLeadStatusHandler,
  unitPausaGetHandler,
  unitPausarHandler,
  unitRetomarHandler,
} from '../controllers/pausa.controller.js';
import { blingAppHandler, blingAutorizarHandler, blingCallbackHandler, blingStatusHandler, blingTesteHandler } from '../controllers/bling.controller.js';
import {
  disparoCampanhaPutHandler,
  disparoOndaAprovarHandler,
  disparoOndaCancelarHandler,
  disparoOndaCriarHandler,
  disparoOndaJsonHandler,
  disparoOndaPainelHandler,
  disparoOndasListarHandler,
} from '../controllers/disparo.controller.js';
import { campanhaColetarHandler, campanhaPainelHandler, campanhaPlacarHandler, campanhaTelaHandler } from '../controllers/campanha.controller.js';
import { listarChavesHandler, painelIntegracoesHandler, salvarChaveHandler } from '../controllers/integracoes.controller.js';
import { widgetPassoEntendiHandler, widgetPassosHandler, widgetHorariosHandler, widgetMarcarHandler,
  widgetCadastrarHandler,
  widgetSugestaoMotivoHandler,
  widgetUsarMotivoHandler, widgetNumerosHandler, widgetPacienteHandler, widgetPingHandler, widgetSyncHandler } from '../controllers/widget-franquia.controller.js';
import { widgetConflitoHandler, widgetEscolherPacienteHandler } from '../controllers/widget-conflito.controller.js';
import { ponteCartaoHandler, pontePausarHandler, ponteResumoIaHandler, ponteRetomarHandler } from '../controllers/ponte.controller.js';
import { ponteContadorHandler, ponteFilaHandler } from '../controllers/ponte-fila.controller.js';
import { ponteCamposHandler, ponteGuiaHandler, ponteMoverHandler } from '../controllers/ponte-guia.controller.js';
import {
  ponteEtiquetasDaContaHandler,
  ponteLigacaoHandler,
  pontePorEtiquetaHandler,
  ponteRespostasHandler,
  ponteTirarEtiquetaHandler,
} from '../controllers/ponte-acoes.controller.js';
import { faxinaConversasHandler, avisoNaoLidasHandler, preencheCamposHandler } from '../controllers/faxina.controller.js';
import { relatorioRedeDiariaHandler } from '../controllers/relatorio-rede.controller.js';
import { relatorioMensalRedeHandler } from '../controllers/relatorio-mensal-rede.controller.js';
import {
  cerebroPanoramaHandler,
  cerebroPacienteHandler,
  cerebroUnidadesHandler,
  chaveDeServicoOuSessao,
} from '../controllers/cerebro.controller.js';
import { listarAltaHandler, decidirAltaHandler } from '../controllers/alta.controller.js';
import { previaCargaHandler, aplicarCargaHandler } from '../controllers/franquia-carga.controller.js';
import {
  listarAutomacoesHandler,
  definirAutomacaoHandler,
  limparAutomacaoHandler,
  redeAutomacoesHandler,
  simulacoesHandler,
} from '../controllers/automacoes.controller.js';
import { digitandoHandler } from '../controllers/whatsapp-meta.controller.js';
import {
  ligacaoCombinarHandler,
  ligacaoDesligarHandler,
  ligacaoEstadoHandler,
  ligacaoFilaHandler,
  ligacaoLigarHandler,
  ligacaoPainelHandler,
  ligacaoPermissaoHandler,
  webhookLigacoesHandler,
  webhookLigacoesVerifyHandler,
} from '../controllers/ligacao-whatsapp.controller.js';
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
// Ligação pelo WhatsApp: webhook `calls` da Meta (repassado pelo n8n com X-DD-Token, ou direto com a assinatura).
apiRouter.get('/webhooks/whatsapp/ligacoes', webhookLigacoesVerifyHandler);
apiRouter.post('/webhooks/whatsapp/ligacoes', webhookLigacoesHandler);

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

// Recepção pausa a Sofia pela página /pausa/:slug com o código da unidade (sem sessão).
apiRouter.get('/public/pausa/:slug', publicStatusHandler);
apiRouter.post('/public/pausa/:slug', publicPausarHandler);
apiRouter.delete('/public/pausa/:slug', publicRetomarHandler);
// Pausa de UM lead, com data de volta (mesmo código da unidade).
apiRouter.get('/public/pausa/:slug/lead/:leadId', publicLeadStatusHandler);
apiRouter.post('/public/pausa/:slug/lead/:leadId', publicLeadPausarHandler);
apiRouter.delete('/public/pausa/:slug/lead/:leadId', publicLeadRetomarHandler);

// Widgets privados do Kommo (coluna do cartão) leem a agenda da franquia com chave por unidade (sem sessão).
apiRouter.get('/public/widget/:slug/ping', widgetPingHandler);
apiRouter.get('/public/widget/:slug/sync', widgetSyncHandler);
apiRouter.get('/public/widget/:slug/paciente', widgetPacienteHandler);
// Dois pacientes da franquia no mesmo telefone (regra de 16/10): a SDR escolhe UMA vez qual é o do cartão.
apiRouter.get('/public/widget/:slug/conflito', widgetConflitoHandler);
apiRouter.post('/public/widget/:slug/conflito/escolher', widgetEscolherPacienteHandler);
apiRouter.get('/public/widget/:slug/numeros', widgetNumerosHandler);
// Extensão "Ponte" do WhatsApp Web: o cartão do Kommo da conversa aberta. Mesma chave por unidade, SÓ LEITURA.
// Fica ACIMA do requireAuth global, como toda /public: abaixo dele a chave nunca seria lida.
// POST para nome e telefone irem no corpo, fora da URL (log de acesso); não escreve nada.
apiRouter.post('/public/widget/:slug/ponte/cartao', ponteCartaoHandler);
// Fase 2 da Ponte: a fila do dia (só leitura, cache por conta), pausar/retomar a Sofia num paciente (a mesma
// pausa do widget "Pausar a Sofia", única escrita da Ponte — no Kommo, nunca no WhatsApp) e o "Resumir com IA".
apiRouter.get('/public/widget/:slug/ponte/fila', ponteFilaHandler);
apiRouter.post('/public/widget/:slug/ponte/pausa', pontePausarHandler);
apiRouter.delete('/public/widget/:slug/ponte/pausa', ponteRetomarHandler);
apiRouter.post('/public/widget/:slug/ponte/resumo-ia', ponteResumoIaHandler);
// Fase 3 da Ponte: etiquetas (ver as da conta, pôr e tirar — ▶ só com confirmação), o resultado da ligação da
// fila "Começar a ligar" (campos ☎ + nota) e as respostas prontas para COPIAR. Tudo no Kommo, nunca no WhatsApp.
apiRouter.get('/public/widget/:slug/ponte/etiquetas', ponteEtiquetasDaContaHandler);
apiRouter.post('/public/widget/:slug/ponte/etiquetas', pontePorEtiquetaHandler);
apiRouter.delete('/public/widget/:slug/ponte/etiquetas', ponteTirarEtiquetaHandler);
apiRouter.post('/public/widget/:slug/ponte/ligacao', ponteLigacaoHandler);
apiRouter.get('/public/widget/:slug/ponte/respostas', ponteRespostasHandler);
// Fase 4 da Ponte (0.4.0): "O que eu faço agora?" — o guia da etapa (só leitura), gravar os campos que faltam e
// mudar a etapa (só as do COMERCIAL que são da SDR; nunca GANHO nem TRATAMENTO; confirmação explícita, porque mover
// dispara os robôs da etapa). E o contador do ícone: pacientes esperando resposta (só leitura, cache por conta).
apiRouter.get('/public/widget/:slug/ponte/guia', ponteGuiaHandler);
apiRouter.post('/public/widget/:slug/ponte/campos', ponteCamposHandler);
apiRouter.post('/public/widget/:slug/ponte/mover', ponteMoverHandler);
apiRouter.get('/public/widget/:slug/ponte/contador', ponteContadorHandler);
// Marcar consulta de dentro do cartão (unidade sem Sofia): mesma chave por unidade, limite próprio de escrita.
apiRouter.get('/public/widget/:slug/horarios', widgetHorariosHandler);
apiRouter.post('/public/widget/:slug/marcar', widgetMarcarHandler);
// Só cadastrar o paciente na franquia, sem consulta (botão do widget; liga por unidade na tela de Automações).
apiRouter.post('/public/widget/:slug/cadastrar', widgetCadastrarHandler);
apiRouter.get('/public/widget/:slug/sugestao-motivo', widgetSugestaoMotivoHandler);
apiRouter.post('/public/widget/:slug/sugestao-motivo/usar', widgetUsarMotivoHandler);
// O que o widget ensina no cartão: o que esta pessoa já entendeu, e o "entendi".
apiRouter.get('/public/widget/:slug/passos', widgetPassosHandler);
apiRouter.post('/public/widget/:slug/passos', widgetPassoEntendiHandler);
// Ligação pelo WhatsApp de dentro do cartão (Calling API da Meta) — ver controllers/ligacao-whatsapp.controller.ts.
apiRouter.get('/public/widget/:slug/ligacao/painel', ligacaoPainelHandler);
apiRouter.get('/public/widget/:slug/ligacao/fila', ligacaoFilaHandler);
apiRouter.post('/public/widget/:slug/ligacao/permissao', ligacaoPermissaoHandler);
apiRouter.post('/public/widget/:slug/ligacao/combinar', ligacaoCombinarHandler);
apiRouter.post('/public/widget/:slug/ligacao/ligar', ligacaoLigarHandler);
apiRouter.get('/public/widget/:slug/ligacao/chamada/:id', ligacaoEstadoHandler);
apiRouter.post('/public/widget/:slug/ligacao/chamada/:id/desligar', ligacaoDesligarHandler);

// Recepção decide alta e recuperação pela página /alta/:slug (mesmo código da unidade).
// ALTA nunca é automática: o gatilho dela dispara um bot sem nenhuma condição.
apiRouter.get('/public/alta/:slug', listarAltaHandler);
apiRouter.post('/public/alta/:slug', decidirAltaHandler);

// "Digitando…" + tique azul. Quem chama é o n8n do rastreio, que é quem tem o
// `wamid` do webhook cru da Meta; a decisão de acender fica aqui.
apiRouter.post('/public/whatsapp/:slug/digitando', digitandoHandler);

// O cérebro (produto de organização de CRM, sem IA atendendo): lê a franquia e o Kommo
// lado a lado e devolve o que não bate. Só leitura — quem escreve campo é outra rota,
// que ainda não existe, e mover etapa nunca vai ser daqui.
//
// Fica ACIMA do `requireAuth` de propósito: a rotina das 17h entra por chave de serviço,
// e o `requireAuth` global responderia 401 antes de alguém olhar a chave. Quem entra sem
// chave passa pela mesma cadeia de sempre — `requireAuth` e depois o acesso à unidade —,
// então pelo navegador nada muda.
apiRouter.get('/cerebro/unidades', chaveDeServicoOuSessao(requireAuth), cerebroUnidadesHandler);
apiRouter.get(
  '/units/:id/cerebro/panorama',
  chaveDeServicoOuSessao(requireAuth, requireUnitAccess),
  cerebroPanoramaHandler,
);
apiRouter.get(
  '/units/:id/cerebro/paciente',
  chaveDeServicoOuSessao(requireAuth, requireUnitAccess),
  cerebroPacienteHandler,
);

// A faxina do inbox: o n8n chama às 20h com a chave de serviço. Acima do requireAuth
// pelo mesmo motivo das rotas do cérebro — o 401 global viria antes de alguém ler a
// chave. Simula por padrão; só fecha de verdade com `simular: false` no corpo.
apiRouter.post('/faxina/conversas', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), faxinaConversasHandler);
apiRouter.post('/alertas/nao-lidas', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), avisoNaoLidasHandler);

// O relatório das 18h da rede (chefe). SÓ LEITURA: devolve texto e números, não envia nada — o n8n
// é quem manda, depois de o texto ser aprovado. Acima do requireAuth pelo mesmo motivo das rotas
// de cima: com chave de serviço, o 401 global viria antes de alguém olhar a chave.
apiRouter.get('/relatorios/rede-diaria', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), relatorioRedeDiariaHandler);
// Franquia + custo de WhatsApp do mês (alimenta o relatório mensal de CRM). SÓ LEITURA, mesma chave de serviço.
apiRouter.get('/relatorios/mensal-rede', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), relatorioMensalRedeHandler);
apiRouter.post('/campos/preencher', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), preencheCamposHandler);
// Bling (ERP) da HM Tecnologia. O retorno da autorização é PÚBLICO (quem chega é o navegador do
// administrador do Bling, com `code` e `state`). Gravar o aplicativo e gerar o link ESCREVEM: só sessão
// de SUPER_ADMIN. Situação e teste são leitura: aceitam também a chave de serviço (por isso acima do
// requireAuth global).
apiRouter.get('/bling/callback', blingCallbackHandler);
apiRouter.put('/bling/:slug/app', requireAuth, requireSuperAdmin, blingAppHandler);
apiRouter.post('/bling/:slug/autorizar', requireAuth, requireSuperAdmin, blingAutorizarHandler);
apiRouter.get('/bling/:slug/status', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), blingStatusHandler);
apiRouter.get('/bling/:slug/teste', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), blingTesteHandler);

// Placar das campanhas de disparo (Outubro Rosa…). Mostra primeiro nome de paciente: só chave de serviço ou
// super-admin. Acima do requireAuth global, senão a chave nunca é lida.
apiRouter.get('/campanhas/:id', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), campanhaPlacarHandler);
apiRouter.get('/campanhas/:id/painel', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), campanhaPainelHandler);
apiRouter.post('/campanhas/:id/coletar', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), campanhaColetarHandler);
apiRouter.put('/campanhas/:id/tela', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), campanhaTelaHandler);

// Disparo de campanha pela API oficial (campanha → onda → destinatário). Preparar, ler e PARAR aceitam a chave de
// serviço; APROVAR só com sessão de super-admin (e o e-mail em DISPARO_APROVADORES): o robô não aprova o próprio envio.
apiRouter.put('/disparo/campanhas/:slug', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), disparoCampanhaPutHandler);
apiRouter.get('/disparo/ondas', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), disparoOndasListarHandler);
apiRouter.post('/disparo/ondas', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), disparoOndaCriarHandler);
apiRouter.get('/disparo/ondas/:id', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), disparoOndaJsonHandler);
apiRouter.get('/disparo/ondas/:id/painel', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), disparoOndaPainelHandler);
apiRouter.post('/disparo/ondas/:id/aprovar', requireAuth, requireSuperAdmin, disparoOndaAprovarHandler);
apiRouter.post('/disparo/ondas/:id/cancelar', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), disparoOndaCancelarHandler);

// Chaves de API de terceiros (Asaas, Convênia, Tiquetaque). Escrever é só com SESSÃO de super-admin (a chave do Asaas
// mexe com dinheiro): a chave de serviço não serve aqui de propósito. Ler o status aceita a chave de serviço.
apiRouter.get('/integracoes', chaveDeServicoOuSessao(requireAuth, requireSuperAdmin), listarChavesHandler);
apiRouter.get('/integracoes/painel', requireAuth, requireSuperAdmin, painelIntegracoesHandler);
apiRouter.put('/integracoes/:slug/:provedor', requireAuth, requireSuperAdmin, salvarChaveHandler);

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
apiRouter.get('/units/:id/funcionamento', requireUnitAccess, funcionamentoHandler);
apiRouter.get('/units/:id/pausa', requireUnitAccess, unitPausaGetHandler);
apiRouter.post('/units/:id/pausa', requireUnitAccess, unitPausarHandler);
apiRouter.delete('/units/:id/pausa', requireUnitAccess, unitRetomarHandler);
apiRouter.get('/units/:id/dashboard', requireUnitAccess, dashboardHandler);
apiRouter.get('/units/:id/painel-unidade', requireUnitAccess, painelUnidadeHandler);
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

// Carga de implantação (equipe DD): traz pro Kommo os pacientes que só existem na franquia.
// Fica ABAIXO do requireAuth de propósito, e com requireSuperAdmin: é operação de implantação,
// não do dia a dia da unidade. O POST só escreve com `aplicar: true` no corpo.
apiRouter.get('/units/:id/implantacao/carga', requireSuperAdmin, previaCargaHandler);
apiRouter.post('/units/:id/implantacao/carga', requireSuperAdmin, aplicarCargaHandler);

// Automações por unidade. Super admin porque metade delas move cartão.
apiRouter.get('/automacoes/rede', requireSuperAdmin, redeAutomacoesHandler);
apiRouter.get('/units/:id/automacoes', requireSuperAdmin, listarAutomacoesHandler);
apiRouter.get('/units/:id/automacoes/:automacao/simulacoes', requireSuperAdmin, simulacoesHandler);
apiRouter.put('/units/:id/automacoes/:automacao', requireSuperAdmin, definirAutomacaoHandler);
apiRouter.delete('/units/:id/automacoes/:automacao', requireSuperAdmin, limparAutomacaoHandler);
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

// Sincronizador franquia → Kommo (campos + etapas): último resumo por unidade e varredura fora de hora.
// João, 23/09/2026: "pode rodar agora pra consertar esses cartões, depois segue de 15 em 15". `?slug=` limita a uma unidade.
apiRouter.get('/admin/franquia-sync', requireSuperAdmin, async (_req, res) => {
  const { resumoDoSync, varredurasEmVoo, panoramaDoSync } = await import('../lib/franquia-sync-worker.js');
  // `emVoo` e `panorama` são o que explicam por que a fila não andou — sem eles a tela só mostra o
  // passado, e a pergunta "por que forçar não pegou?" continua sem resposta.
  res.json({
    ok: true,
    varreduras: resumoDoSync(),
    emVoo: varredurasEmVoo(),
    panorama: await panoramaDoSync(),
  });
});
apiRouter.post('/admin/franquia-sync/varrer', requireSuperAdmin, async (req, res) => {
  const { varrerAgora } = await import('../lib/franquia-sync-worker.js');
  const slug = typeof req.query.slug === 'string' && req.query.slug.trim() ? req.query.slug.trim() : undefined;
  res.status(202).json({ ok: true, slug: slug ?? '*', ...varrerAgora(slug) });
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
