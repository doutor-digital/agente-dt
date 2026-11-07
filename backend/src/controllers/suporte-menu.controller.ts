/**
 * Webhook do menu de suporte no WhatsApp (instância do agente de suporte no Evolution).
 *
 * Responde 200 NA HORA (o Evolution não espera nem repete por causa de resposta lenta) e trata a mensagem depois, em fila
 * por conversa. Só passa quem conhece o segredo (`?k=` ou cabeçalho `x-suporte-segredo`); o resto é 401 sem dizer o porquê.
 * Com `SUPORTE_MENU` desligado o webhook responde 200 e não faz nada.
 */
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { extrairMensagem, lerConfig, segredoConfere } from '../lib/suporte-menu.js';
import { tratarMensagemRecebida } from '../lib/suporte-menu-banco.js';

export function suporteMenuWebhookHandler(req: Request, res: Response): void {
  const config = lerConfig();
  const recebido = typeof req.query.k === 'string' ? req.query.k : req.get('x-suporte-segredo');
  if (!segredoConfere(config, recebido)) {
    logger.warn({ ip: req.ip }, 'suporte-menu: webhook sem segredo válido');
    res.status(401).json({ ok: false });
    return;
  }
  if (config.modo === 'desligado') {
    res.status(200).json({ ok: true, ignorado: 'desligado' });
    return;
  }
  const lida = extrairMensagem(req.body, config);
  res.status(200).json({ ok: true, ...(lida.ok ? {} : { ignorado: lida.motivo }) });
  if (lida.ok) void tratarMensagemRecebida(lida.msg, config);
}
