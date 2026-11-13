/**
 * Tela "Agente" no menu do Chatwoot (pedido do João, 13/11/2026: "algo onde eles possam cuidar da própria IA deles; o que for de
 * código fonte envolve a gente"). A página é `lib/agente-pagina.ts`; aqui ficam as rotas que só ela usa. Todas pedem o LOGIN do
 * Chatwoot da atendente (cabeçalhos X-CW-*) e que ela atenda uma caixa da unidade pedida (`atendenteDaUnidade`).
 *
 *   GET  /api/public/agente/painel?slug=&periodo=   painel da Sofia (hoje | 7 | 30 dias) + as 👎 para revisar
 *   GET  /api/public/agente/avaliacoes?slug=        resumo dos 👍/👎 e as 👎 para revisar
 *   POST /api/public/agente/avaliacoes/:id/revisar  { slug, como: regra | pedido | ok }
 *   GET  /api/public/agente/pedidos?slug=           pedidos à Doutor Digital feitos pela unidade
 *   POST /api/public/agente/pedidos                 { slug, tipo, texto, conversa? } → demanda no suporte + aviso no bot de chamados
 *
 * As regras, a conversa de teste e as pausadas usam as rotas de /aprendizados e /testar-ia, que já aceitam o login do Chatwoot.
 */
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { contaChatwootDoAmbiente } from '../mcp-remoto/chatwoot.js';
import { enviarTelegramChamados } from '../lib/telegram.js';
import { atendenteDaUnidade } from './aprendizados.controller.js';
import { COMO_REVISOU, marcarRevisada, resumoDaUnidade, type ComoRevisou } from '../lib/sofia-avaliacoes.js';
import { MAX_PEDIDOS_POR_DIA, avisoDoPedido, criarPedido, lerPedido, marcarAvisado, pedidosDaUnidade, pedidosHoje, TIPOS_DE_PEDIDO } from '../lib/agente-pedidos.js';
import { paginaDoAgente } from '../lib/agente-pagina.js';
import { lerPeriodo, painelDaUnidade } from '../lib/agente-painel.js';

const slugDe = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 80) : '');

/** A página (iframe do menu do Chatwoot). */
export function paginaAgenteHandler(_req: Request, res: Response): void {
  const conta = contaChatwootDoAmbiente();
  if (!conta) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">Chatwoot não configurado.</p>');
    return;
  }
  res.type('html').set('Cache-Control', 'no-store').send(paginaDoAgente(new URL(conta.url).origin));
}

/** O painel da Sofia (Início): respondidas, marcadas, conversão, equipe, Pix, fora do horário, avaliações, por dia + 👎 para revisar. */
export async function agentePainelHandler(req: Request, res: Response): Promise<void> {
  const r = await atendenteDaUnidade(req, res, slugDe(req.query.slug));
  if (!r) return;
  try {
    const [painel, resumo] = await Promise.all([painelDaUnidade(r.unit, lerPeriodo(req.query.periodo)), resumoDaUnidade(r.unit.slug)]);
    res.set('Cache-Control', 'no-store').json({ ...painel, paraRevisar: resumo.paraRevisar });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'agente: painel falhou');
    res.status(502).json({ error: 'não consegui montar o painel agora' });
  }
}

export async function agenteAvaliacoesHandler(req: Request, res: Response): Promise<void> {
  const r = await atendenteDaUnidade(req, res, slugDe(req.query.slug));
  if (!r) return;
  try {
    res.set('Cache-Control', 'no-store').json(await resumoDaUnidade(r.unit.slug));
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'agente: resumo das avaliações falhou');
    res.status(502).json({ error: 'não consegui ler as avaliações agora' });
  }
}

export async function agenteRevisarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; como?: unknown };
  const como = String(corpo.como ?? '') as ComoRevisou;
  if (!COMO_REVISOU.includes(como)) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  const r = await atendenteDaUnidade(req, res, slugDe(corpo.slug));
  if (!r) return;
  try {
    const ok = await marcarRevisada(String(req.params.id ?? ''), r.unit.slug, r.a.nome || 'atendente', como);
    if (!ok) {
      res.status(404).json({ error: 'essa avaliação já foi revisada (ou não existe)' });
      return;
    }
    logger.info({ unit: r.unit.slug, id: req.params.id, como, quem: r.a.id }, 'agente: 👎 revisada');
    res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: String(e) }, 'agente: revisar falhou');
    res.status(502).json({ error: 'não consegui gravar agora' });
  }
}

export async function agentePedidosHandler(req: Request, res: Response): Promise<void> {
  const r = await atendenteDaUnidade(req, res, slugDe(req.query.slug));
  if (!r) return;
  try {
    res.set('Cache-Control', 'no-store').json({
      tipos: Object.entries(TIPOS_DE_PEDIDO).map(([id, t]) => ({ id, rotulo: t.rotulo })),
      pedidos: await pedidosDaUnidade(r.unit.slug),
    });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'agente: pedidos falhou');
    res.status(502).json({ error: 'não consegui ler os pedidos agora' });
  }
}

export async function agenteNovoPedidoHandler(req: Request, res: Response): Promise<void> {
  const p = lerPedido(req.body);
  if (!p.ok) {
    res.status(400).json({ error: p.erro });
    return;
  }
  const r = await atendenteDaUnidade(req, res, slugDe((req.body as { slug?: unknown })?.slug));
  if (!r) return;
  try {
    if ((await pedidosHoje(r.unit.slug)) >= MAX_PEDIDOS_POR_DIA) {
      res.status(429).json({ error: `A unidade já mandou ${MAX_PEDIDOS_POR_DIA} pedidos nas últimas 24 horas. Junte o resto num pedido só ou fale com a Suzanne.` });
      return;
    }
    const nome = r.a.nome || 'atendente';
    const { protocolo } = await criarPedido({ slug: r.unit.slug, unidade: r.unit.name, quemId: r.a.id ?? null, nome, tipo: p.tipo, texto: p.texto, conversa: p.conversa });
    logger.info({ unit: r.unit.slug, protocolo, tipo: p.tipo, quem: r.a.id }, 'agente: pedido à Doutor Digital');
    const avisou = await enviarTelegramChamados(avisoDoPedido({ protocolo, unidade: r.unit.name, nome, tipo: p.tipo, texto: p.texto })).catch(() => false);
    await marcarAvisado(protocolo, avisou).catch(() => undefined);
    if (!avisou) logger.warn({ protocolo }, 'agente: o aviso do pedido NÃO saiu no bot de chamados (fica no painel do suporte)');
    res.json({ ok: true, protocolo, pedidos: await pedidosDaUnidade(r.unit.slug) });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'agente: pedido falhou');
    res.status(502).json({ error: 'não consegui registrar o pedido agora. Tente de novo em instantes.' });
  }
}
