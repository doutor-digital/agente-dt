/**
 * POST /api/webhooks/pluggy — avisos da Pluggy (item atualizado / item com erro) para o conector de leitura bancária.
 * Endereço público a cadastrar no Dashboard da Pluggy: https://agente-vps.doutordigitalconsultoria.com/api/webhooks/pluggy
 *
 * Lê o corpo CRU (a assinatura é sobre os bytes exatos), por isso é montado ANTES do parser JSON geral do servidor. Sem PLUGGY_WEBHOOK_SECRET a rota
 * responde 404; com ele, só passa quem tem assinatura válida (ver `lib/integracoes/pluggy-webhook.ts`). Responde na hora; o que há para fazer roda depois.
 */
import express, { type Express, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import { enviarTelegram } from '../lib/telegram.js';
import { clienteCompartilhado, lerItensDoAmbiente } from '../lib/integracoes/pluggy.js';
import { criarTratadorDoWebhook, type DependenciasDoWebhook } from '../lib/integracoes/pluggy-webhook.js';

export const ROTA_WEBHOOK_PLUGGY = '/api/webhooks/pluggy';

function dependenciasPadrao(): DependenciasDoWebhook {
  return {
    ambiente: () => process.env,
    agora: Date.now,
    invalidarItem: (id) => clienteCompartilhado()?.invalidarItem(id),
    avisar: (texto) => enviarTelegram(texto),
    log: logger,
    itensConhecidos: () => new Map(lerItensDoAmbiente(process.env.PLUGGY_ITENS).entradas.map((e) => [e.itemId, { ...(e.apelido ? { apelido: e.apelido } : {}) }])),
  };
}

export function ligarWebhookPluggy(app: Express, deps: DependenciasDoWebhook = dependenciasPadrao()): void {
  const tratar = criarTratadorDoWebhook(deps);
  app.post(ROTA_WEBHOOK_PLUGGY, express.raw({ type: () => true, limit: '256kb' }), (req: Request, res: Response) => {
    const corpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = tratar(corpo, req.get('X-Pluggy-Signature'));
    res.status(r.status).end();
    if (r.depois) {
      // depois da resposta: erro aqui não pode virar 5xx (a Pluggy reenviaria) nem derrubar o processo
      void r.depois().catch((err) => logger.warn({ err: String(err).slice(0, 200) }, 'pluggy: erro ao tratar o webhook depois de responder'));
    }
  });
}
