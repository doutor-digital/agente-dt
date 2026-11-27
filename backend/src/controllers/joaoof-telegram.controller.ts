/**
 * Webhook do Telegram do Joaoof: as mensagens do João ao bot (a «volta» do aviso). Mesmo desenho do webhook do @ddchamados_bot:
 * o segredo vem no CABEÇALHO `X-Telegram-Bot-Api-Secret-Token` (nunca na URL — a URL cai no log), responde 200 na hora e trata depois.
 * Quem não é o João (chat 7822226023) é ignorado em silêncio. Sem `JOAOOF_TELEGRAM_SEGREDO` o webhook recusa tudo.
 */
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { segredoDoTelegramConfere } from '../lib/suporte-pausa.js';
import { tratarMensagemDoJoao, type DepsTelegramJoao } from '../joaoof/telegram-joao.js';

export const CABECALHO_SEGREDO_JOAOOF = 'x-telegram-bot-api-secret-token';

export function criarJoaoofTelegramHandler(deps: () => DepsTelegramJoao, env: NodeJS.ProcessEnv = process.env) {
  return function joaoofTelegramWebhookHandler(req: Request, res: Response): void {
    if (!segredoDoTelegramConfere(env.JOAOOF_TELEGRAM_SEGREDO, req.get(CABECALHO_SEGREDO_JOAOOF))) {
      logger.warn({ ip: req.ip }, 'joaoof: webhook do Telegram sem segredo válido');
      res.status(401).json({ ok: false });
      return;
    }
    res.status(200).json({ ok: true });
    void tratarMensagemDoJoao(req.body, deps())
      .then((r) => {
        if (r.acao === 'ignorou' && r.motivo === 'chat não autorizado') logger.warn('joaoof: mensagem de um chat não autorizado — ignorada');
      })
      .catch((err) => logger.error({ err: String(err) }, 'joaoof: erro ao tratar a mensagem do João'));
  };
}

/** A fiação de produção (Prisma, Anthropic) só carrega no primeiro uso: o teste do controller não precisa de env nem de rede. */
export function joaoofTelegramWebhookHandler(req: Request, res: Response): void {
  void import('../joaoof/producao.js')
    .then(({ depsTelegramReais }) => criarJoaoofTelegramHandler(depsTelegramReais)(req, res))
    .catch((err) => {
      logger.error({ err: String(err) }, 'joaoof: não consegui carregar a fiação do webhook');
      if (!res.headersSent) res.status(500).json({ ok: false });
    });
}
