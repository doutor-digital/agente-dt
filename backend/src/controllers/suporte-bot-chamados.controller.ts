/**
 * Webhook do @ddchamados_bot (Telegram): os comandos /pausar, /voltar e /status do menu de suporte, aceitos SÓ do chat do João.
 *
 * Como o Telegram chega até aqui: o João roda `liberar-comandos-chamados.sh`, que grava `TELEGRAM_CHAMADOS_SEGREDO` no .env da VPS e
 * registra o webhook (`setWebhook` com `secret_token`). O Telegram então manda esse segredo no cabeçalho
 * `X-Telegram-Bot-Api-Secret-Token` em CADA chamada; o segredo nunca vai na URL (a URL cai no log do servidor — lição do #242).
 *
 * Responde 200 na hora (o Telegram repete o que não recebe 2xx) e trata depois. Remetente que não é o João é ignorado em silêncio.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { configTelegram, enviarTelegramChamados } from '../lib/telegram.js';
import { modoDoSuporte } from '../lib/suporte-menu.js';
import { modoDoLembrete } from '../lib/suporte-lembrete.js';
import { armazemPausaPrisma } from '../lib/suporte-pausa-banco.js';
import { executarComando, lerAtualizacao, segredoDoTelegramConfere, type DepsComando } from '../lib/suporte-pausa.js';

export const CABECALHO_SEGREDO = 'x-telegram-bot-api-secret-token';

export interface DepsBot extends DepsComando {
  /** o chat autorizado (do canal `chamados`); vazio = o canal não tem bot próprio e nada é aceito */
  chatPermitido(): string;
  responder(texto: string): Promise<boolean>;
}

export function depsReais(): DepsBot {
  return {
    pausa: armazemPausaPrisma,
    agora: () => new Date(),
    modoDoMenu: () => modoDoSuporte(process.env.SUPORTE_MENU),
    async dadosDoStatus() {
      const contagem = await prisma.suporteDemanda.groupBy({ by: ['status'], where: { status: { in: ['aberta', 'reaberta'] } }, _count: { _all: true } });
      const n = (s: string) => contagem.find((c) => c.status === s)?._count._all ?? 0;
      const lembrete = modoDoLembrete(process.env.SUPORTE_LEMBRETE);
      return { abertas: n('aberta') + n('reaberta'), reabertas: n('reaberta'), lembrete: lembrete === 'ligado' ? 'ligado' : lembrete === 'seco' ? 'seco (só no log)' : 'desligado' };
    },
    // o comando só vale se o canal tem bot PRÓPRIO: sem ele o canal cai no DD-Avisos, que não é este webhook
    chatPermitido() {
      const cfg = configTelegram(process.env, 'chamados');
      return cfg && cfg.canal === 'chamados' ? cfg.chat : '';
    },
    responder: (texto) => enviarTelegramChamados(texto),
  };
}

/** Trata uma atualização do Telegram. Nunca lança. Devolve o que fez (para o teste e para o log). */
export async function tratarAtualizacao(corpo: unknown, deps: DepsBot): Promise<{ acao: 'respondeu' | 'ignorou'; motivo?: string }> {
  const lida = lerAtualizacao(corpo, deps.chatPermitido());
  if (!lida.ok) return { acao: 'ignorou', motivo: lida.motivo };
  try {
    const texto = await executarComando(lida.comando, deps);
    const enviou = await deps.responder(texto);
    if (!enviou) logger.warn({ comando: lida.comando }, 'suporte-bot-chamados: o comando foi executado, mas a resposta não chegou ao Telegram');
    logger.info({ comando: lida.comando }, 'suporte-bot-chamados: comando atendido');
    return { acao: 'respondeu' };
  } catch (err) {
    logger.error({ err: String(err), comando: lida.comando }, 'suporte-bot-chamados: o comando falhou');
    await deps.responder('⚠️ Não consegui executar o comando agora (erro no servidor). Tente de novo em instantes.').catch(() => false);
    return { acao: 'ignorou', motivo: 'erro' };
  }
}

export function criarTelegramChamadosHandler(deps: () => DepsBot = depsReais, env: NodeJS.ProcessEnv = process.env) {
  return function telegramChamadosWebhookHandler(req: Request, res: Response): void {
    if (!segredoDoTelegramConfere(env.TELEGRAM_CHAMADOS_SEGREDO, req.get(CABECALHO_SEGREDO))) {
      logger.warn({ ip: req.ip }, 'suporte-bot-chamados: webhook sem segredo válido');
      res.status(401).json({ ok: false });
      return;
    }
    res.status(200).json({ ok: true });
    void tratarAtualizacao(req.body, deps()).then((r) => {
      if (r.acao === 'ignorou' && r.motivo === 'chat não autorizado') logger.warn('suporte-bot-chamados: mensagem de um chat não autorizado — ignorada');
    });
  };
}

export const telegramChamadosWebhookHandler = criarTelegramChamadosHandler();
