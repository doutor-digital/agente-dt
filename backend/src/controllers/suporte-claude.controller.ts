/**
 * Rotas do agente de suporte 24 h (Claude Code na VPS).
 *   - `POST /api/suporte/claude/proxima` e `/:protocolo/resultado`: só o TRABALHADOR, com `x-suporte-claude-chave`;
 *   - `POST /api/suporte/demandas/:protocolo/claude`: o painel (administrador geral) manda uma demanda para o agente.
 * Regras em `lib/suporte-claude.ts`.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { enviarTelegramChamados } from '../lib/telegram.js';
import { neutralizarMarcadores, neutralizarMarcadoresProfundo } from '../lib/suporte-complemento.js';
import {
  TRABALHO_PRESO_MIN,
  cartaoDoAgente,
  chaveDoTrabalhadorConfere,
  lerModoClaude,
  lerResultado,
  podeMandarPeloPainel,
} from '../lib/suporte-claude.js';

const protocoloDe = (req: Request): number | null => {
  const n = Number(req.params.protocolo);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function trabalhadorAutorizado(req: Request, res: Response): boolean {
  if (chaveDoTrabalhadorConfere(req.get('x-suporte-claude-chave'))) return true;
  logger.warn({ ip: req.ip }, 'suporte-claude: chamada do trabalhador sem chave válida');
  res.status(401).json({ ok: false });
  return false;
}

/** O trabalhador pede a próxima demanda da fila (reserva atômica). 204 = nada a fazer (ou agente desligado). */
export async function proximaHandler(req: Request, res: Response): Promise<void> {
  if (!trabalhadorAutorizado(req, res)) return;
  if (lerModoClaude() !== 'ligado') {
    res.status(204).end();
    return;
  }
  // trabalho preso (o trabalhador caiu no meio): dá como falho para não travar a fila
  const presas = await prisma.suporteDemanda.updateMany({
    where: { claudeStatus: 'trabalhando', claudeIniciadoEm: { lt: new Date(Date.now() - TRABALHO_PRESO_MIN * 60_000) } },
    data: { claudeStatus: 'falhou', claudeTerminadoEm: new Date(), claudeResumo: `O agente não respondeu em ${TRABALHO_PRESO_MIN} min (tempo esgotado).` },
  });
  if (presas.count) logger.warn({ presas: presas.count }, 'suporte-claude: trabalho preso dado como falho');

  const proxima = await prisma.suporteDemanda.findFirst({ where: { claudeStatus: 'fila' }, orderBy: { protocolo: 'asc' } });
  if (!proxima) {
    res.status(204).end();
    return;
  }
  const r = await prisma.suporteDemanda.updateMany({
    where: { protocolo: proxima.protocolo, claudeStatus: 'fila' },
    data: { claudeStatus: 'trabalhando', claudeIniciadoEm: new Date() },
  });
  if (r.count !== 1) {
    res.status(204).end(); // outro trabalhador pegou no mesmo instante
    return;
  }
  const conhecimento = await prisma.suporteConhecimento.findMany({ where: { ativo: true }, select: { titulo: true, texto: true }, orderBy: { atualizadoEm: 'desc' } });
  res.json({
    protocolo: proxima.protocolo,
    categoria: proxima.categoriaNome,
    // o trabalhador põe isto entre <<<RELATO>>> e <<<FIM>>> num agente que edita e faz commit: nada aqui imita o marcador
    relato: neutralizarMarcadores(proxima.relato),
    nome: proxima.nome === null ? null : neutralizarMarcadores(proxima.nome),
    unidadeSlug: proxima.unidadeSlug,
    verificacao: proxima.verificacao,
    autorizadoPor: proxima.claudeAutorizadoPor,
    analise: neutralizarMarcadoresProfundo(proxima.analise),
    conhecimento,
  });
}

/** O trabalhador devolve o resultado. Só aceita para demanda que está "trabalhando". */
export async function resultadoHandler(req: Request, res: Response): Promise<void> {
  if (!trabalhadorAutorizado(req, res)) return;
  const p = protocoloDe(req);
  if (!p) {
    res.status(400).json({ error: 'protocolo inválido' });
    return;
  }
  const lido = lerResultado(req.body);
  if (!lido.ok) {
    res.status(400).json({ error: lido.erro });
    return;
  }
  const r = lido.r;
  const feito = await prisma.suporteDemanda.updateMany({
    where: { protocolo: p, claudeStatus: 'trabalhando' },
    data: {
      claudeStatus: r.ok ? 'feito' : 'falhou',
      claudeTerminadoEm: new Date(),
      claudeResumo: r.resumo,
      claudePrUrl: r.prUrl,
      claudePrecisaPessoa: r.precisaPessoa,
      claudeOQueFazer: r.oQueFazer,
    },
  });
  if (feito.count !== 1) {
    res.status(409).json({ error: 'a demanda não está com o agente' });
    return;
  }
  await enviarTelegramChamados(cartaoDoAgente(p, r));
  res.json({ ok: true });
}

/** Painel: manda uma demanda para o agente (inclusive as de número não verificado). */
export async function mandarParaClaudeHandler(req: Request, res: Response): Promise<void> {
  const p = protocoloDe(req);
  if (!p) {
    res.status(400).json({ error: 'protocolo inválido' });
    return;
  }
  if (lerModoClaude() !== 'ligado') {
    res.status(409).json({ error: 'o agente está desligado (SUPORTE_CLAUDE)' });
    return;
  }
  const d = await prisma.suporteDemanda.findUnique({ where: { protocolo: p }, select: { status: true, claudeStatus: true } });
  if (!d) {
    res.status(404).json({ error: 'demanda não encontrada' });
    return;
  }
  const pode = podeMandarPeloPainel(d.status, d.claudeStatus);
  if (!pode.ok) {
    res.status(409).json({ error: pode.erro });
    return;
  }
  const quem = req.user?.email ?? req.user?.id ?? 'painel';
  await prisma.suporteDemanda.update({
    where: { protocolo: p },
    data: { claudeStatus: 'fila', claudeAutorizadoPor: quem, claudeResumo: null, claudePrUrl: null, claudeOQueFazer: null, claudeIniciadoEm: null, claudeTerminadoEm: null },
  });
  res.json({ ok: true });
}
