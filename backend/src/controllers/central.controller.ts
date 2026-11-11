/**
 * Central do João — rotas da extensão do Chrome (fase 1: pausar o agente de chamados geral ou só para a pessoa da conversa aberta).
 *
 *   POST /api/public/central/estado            { numero? } — pausa geral, modo do menu, a pessoa e a lista de pausadas
 *                                              (POST: o número não vai na URL, que fica no log de acesso)
 *   POST /api/public/central/geral             { pausar: boolean }
 *   POST /api/public/central/pessoa            { numero, pausar: boolean, nome? }
 *
 * Todas pedem o cabeçalho X-Central-Chave = CENTRAL_EXTENSAO_CHAVE (≥ 32 caracteres) do .env; sem ela configurada, 404 (desligado).
 * A extensão chama do service worker (host_permissions), então não precisa de CORS. Toda mudança avisa o João no @ddchamados_bot.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { enviarTelegramChamados } from '../lib/telegram.js';
import { lerConfig } from '../lib/suporte-menu.js';
import { armazemPausaPrisma } from '../lib/suporte-pausa-banco.js';
import { mudarPeloPainel } from '../lib/suporte-pausa.js';
import { TEXTOS_CENTRAL, chaveCentralConfere, chaveCentralLigada, nomeLimpo } from '../lib/central-pausa.js';
import { estadoDaPessoa, listarPausadas, mudarPessoa } from '../lib/central-pausa-banco.js';

const POR = 'extensão do Chrome';

function autorizado(req: Request, res: Response): boolean {
  if (!chaveCentralLigada(env.CENTRAL_EXTENSAO_CHAVE)) {
    res.status(404).json({ error: 'Central desligada' });
    return false;
  }
  if (!chaveCentralConfere(env.CENTRAL_EXTENSAO_CHAVE, req.get('x-central-chave'))) {
    res.status(403).json({ error: 'chave da extensão inválida' });
    return false;
  }
  return true;
}

export async function centralEstadoHandler(req: Request, res: Response): Promise<void> {
  if (!autorizado(req, res)) return;
  try {
    const numero = typeof req.body?.numero === 'string' ? req.body.numero.slice(0, 40) : '';
    const [geral, pausadas, pessoa] = await Promise.all([armazemPausaPrisma.ler(), listarPausadas(), numero ? estadoDaPessoa(numero) : null]);
    res.json({ modo: lerConfig().modo, geral, pessoa, pausadas });
  } catch (e) {
    logger.warn({ err: String(e) }, 'central: estado falhou');
    res.status(502).json({ error: 'não consegui ler agora' });
  }
}

const geralSchema = z.object({ pausar: z.boolean() });

export async function centralGeralHandler(req: Request, res: Response): Promise<void> {
  if (!autorizado(req, res)) return;
  const p = geralSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  try {
    const r = await mudarPeloPainel(p.data.pausar, POR, { pausa: armazemPausaPrisma, agora: () => new Date(), modoDoMenu: () => lerConfig().modo });
    if (r.aviso) void enviarTelegramChamados(r.aviso.replace('pelo painel', 'pela extensão'));
    logger.info({ pausar: p.data.pausar, mudou: r.mudou }, 'central: pausa geral pela extensão');
    res.json({ ok: true, mudou: r.mudou, geral: r.estado });
  } catch (e) {
    logger.warn({ err: String(e) }, 'central: pausa geral falhou');
    res.status(502).json({ error: 'não consegui gravar agora' });
  }
}

const pessoaSchema = z.object({ numero: z.string().trim().min(8).max(40), pausar: z.boolean(), nome: z.unknown().optional() });

export async function centralPessoaHandler(req: Request, res: Response): Promise<void> {
  if (!autorizado(req, res)) return;
  const p = pessoaSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  try {
    const nome = nomeLimpo(p.data.nome);
    const r = await mudarPessoa(p.data.numero, p.data.pausar, nome, POR);
    if (!r) {
      res.status(400).json({ error: 'não reconheci o número dessa conversa' });
      return;
    }
    if (r.mudou) {
      const texto = p.data.pausar
        ? TEXTOS_CENTRAL.pausouPessoa(nome, r.final)
        : TEXTOS_CENTRAL.voltouPessoa(r.anterior?.nome ?? nome, r.final, r.anterior?.ignoradas ?? 0);
      void enviarTelegramChamados(texto);
    }
    logger.info({ final: r.final, pausar: p.data.pausar, mudou: r.mudou }, 'central: pausa por pessoa pela extensão');
    res.json({ ok: true, mudou: r.mudou, final: r.final, pausada: p.data.pausar });
  } catch (e) {
    logger.warn({ err: String(e) }, 'central: pausa por pessoa falhou');
    res.status(502).json({ error: 'não consegui gravar agora' });
  }
}
