/**
 * Página `/agente/:slug`: a tela «Agente» do CRM para as unidades que usam o Kommo (pedido do João, 24/11/2026: «eu quero pra Kommo!»).
 * A recepção/dona da clínica abre no celular, digita o código de 6 dígitos da unidade (o mesmo de `/pausa`, `/ia` e `/aprendizados`) e
 * vê os números da Sofia, pausa, ensina, testa, confere e pede ajuste à Doutor Digital.
 *
 * Esta página NÃO duplica lógica: o visual e o JavaScript são os da tela do CRM (`lib/agente-pagina.ts`, modo Kommo) e cada aba fala com
 * a rota que já existe —
 *   Ensinar/Testar → `/api/public/aprendizados/:slug` (chave por unidade `aprendizados-pela-unidade`: desligada = a aba avisa e não liga nada)
 *   Pausar         → `/api/public/pausa/:slug` (unidade) e `/api/public/pausa/:slug/lead/:id` (devolver um cartão)
 *   Conferir       → `/api/public/ia/:slug`
 * e só o que é novo mora aqui: o painel (números do rastro de execução, `lib/agente-kommo-painel.ts`), as conversas pausadas e o pedido à
 * Doutor Digital. O código e o limitador de tentativas são os de `unidadePublica` (12 erros por ip+unidade a cada 10 min): código errado = 403.
 */
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { enviarTelegramChamados } from '../lib/telegram.js';
import { unidadePublica } from './pausa.controller.js';
import { ligadaPara } from './aprendizados.controller.js';
import { lerPeriodo } from '../lib/agente-painel.js';
import { leituraDaUnidade, leituraGuardada, painelDoKommo, pausadasDaUnidade } from '../lib/agente-kommo-painel.js';
import { MAX_PEDIDOS_POR_DIA, avisoDoPedido, criarPedido, lerPedido, marcarAvisado, pedidosDaUnidade, pedidosHoje, TIPOS_DE_PEDIDO } from '../lib/agente-pedidos.js';
import { paginaDoAgenteKommo } from '../lib/agente-pagina.js';

/** Quanto o pedido espera a leitura do banco antes de dizer «lendo…» (a leitura segue por trás e enche o cache). */
const ESPERA_DO_PAINEL_MS = 20_000;

function semCache(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
}

/** A página (sem código: ele é pedido na própria página, como em `/pausa`). */
export async function paginaAgenteKommoHandler(req: Request, res: Response): Promise<void> {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const slug = String(req.params.slug ?? '');
  const unit = await prisma.unit.findUnique({ where: { slug }, select: { name: true, isActive: true } });
  if (!unit || !unit.isActive) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Agente</title><p style="font-family:sans-serif;padding:24px">Unidade não encontrada.</p>');
    return;
  }
  res.type('html').set('Cache-Control', 'no-store').send(paginaDoAgenteKommo(slug));
}

/** Confere o código e diz o que a unidade tem liberado (a página escolhe as abas por aqui). */
export async function agenteKommoEstadoHandler(req: Request, res: Response): Promise<void> {
  semCache(res);
  const unit = await unidadePublica(req, res);
  if (!unit) return;
  res.json({ unidade: unit.name, slug: unit.slug, aprendizados: ligadaPara(unit.slug) });
}

/** Os números da Sofia: respondidas, marcadas, conversão, equipe, Pix, fora do horário, por dia. */
export async function agenteKommoPainelHandler(req: Request, res: Response): Promise<void> {
  semCache(res);
  const unit = await unidadePublica(req, res);
  if (!unit) return;
  const periodo = lerPeriodo(req.query.periodo);
  try {
    const lendo = leituraDaUnidade(unit, periodo);
    const demorou = Symbol('demorou');
    let espera: NodeJS.Timeout | undefined;
    const leitura = await Promise.race([lendo, new Promise<typeof demorou>((ok) => { espera = setTimeout(() => ok(demorou), ESPERA_DO_PAINEL_MS); })]);
    clearTimeout(espera);
    if (leitura === demorou) {
      // a leitura segue por trás; se já há uma antiga, mostra com aviso, senão a página pergunta de novo em instantes
      const antiga = leituraGuardada(unit, periodo);
      if (!antiga) {
        res.status(202).json({ carregando: true, motivo: 'Lendo os números… na primeira vez pode levar até 1 minuto.' });
        return;
      }
      res.json(await painelDoKommo(unit, periodo, { ...antiga, desatualizado: true }));
      return;
    }
    if (!leitura.ok) {
      logger.warn({ unit: unit.slug, motivo: leitura.motivo }, 'agente-kommo: painel falhou');
      res.status(502).json({ error: 'não consegui montar o painel agora' });
      return;
    }
    res.json(await painelDoKommo(unit, periodo, leitura));
  } catch (e) {
    logger.warn({ err: String(e), unit: unit.slug }, 'agente-kommo: painel quebrou');
    res.status(502).json({ error: 'não consegui montar o painel agora' });
  }
}

/** Conversas em que a Sofia está pausada agora (a equipe falou, ou alguém pediu pausa com data). */
export async function agenteKommoPausadasHandler(req: Request, res: Response): Promise<void> {
  semCache(res);
  const unit = await unidadePublica(req, res);
  if (!unit) return;
  try {
    res.json({ conversas: await pausadasDaUnidade(unit) });
  } catch (e) {
    logger.warn({ err: String(e), unit: unit.slug }, 'agente-kommo: pausadas falhou');
    res.status(502).json({ error: 'não consegui ler as conversas pausadas' });
  }
}

export async function agenteKommoPedidosHandler(req: Request, res: Response): Promise<void> {
  semCache(res);
  const unit = await unidadePublica(req, res);
  if (!unit) return;
  try {
    res.json({ tipos: Object.entries(TIPOS_DE_PEDIDO).map(([id, t]) => ({ id, rotulo: t.rotulo })), pedidos: await pedidosDaUnidade(unit.slug) });
  } catch (e) {
    logger.warn({ err: String(e), unit: unit.slug }, 'agente-kommo: pedidos falhou');
    res.status(502).json({ error: 'não consegui ler os pedidos agora' });
  }
}

export async function agenteKommoNovoPedidoHandler(req: Request, res: Response): Promise<void> {
  semCache(res);
  const unit = await unidadePublica(req, res);
  if (!unit) return;
  const p = lerPedido(req.body);
  if (!p.ok) {
    res.status(400).json({ error: p.erro });
    return;
  }
  const por = (req.body as { por?: unknown })?.por;
  const nome = (typeof por === 'string' ? por.trim().slice(0, 80) : '') || 'recepção';
  try {
    if ((await pedidosHoje(unit.slug)) >= MAX_PEDIDOS_POR_DIA) {
      res.status(429).json({ error: `A unidade já mandou ${MAX_PEDIDOS_POR_DIA} pedidos nas últimas 24 horas. Junte o resto num pedido só ou fale com a Suzanne.` });
      return;
    }
    // o cartão (conversa) do Chatwoot não existe aqui: o pedido nasce sem ele
    const { protocolo } = await criarPedido({ slug: unit.slug, unidade: unit.name, quemId: null, nome, tipo: p.tipo, texto: p.texto, conversa: null, origem: 'pagina' });
    logger.info({ unit: unit.slug, protocolo, tipo: p.tipo }, 'agente-kommo: pedido à Doutor Digital');
    const avisou = await enviarTelegramChamados(avisoDoPedido({ protocolo, unidade: unit.name, nome, tipo: p.tipo, texto: p.texto, origem: 'pagina' })).catch(() => false);
    await marcarAvisado(protocolo, avisou).catch(() => undefined);
    if (!avisou) logger.warn({ protocolo }, 'agente-kommo: o aviso do pedido NÃO saiu no bot de chamados (fica no painel do suporte)');
    res.json({ ok: true, protocolo, pedidos: await pedidosDaUnidade(unit.slug) });
  } catch (e) {
    logger.warn({ err: String(e), unit: unit.slug }, 'agente-kommo: pedido falhou');
    res.status(502).json({ error: 'não consegui registrar o pedido agora. Tente de novo em instantes.' });
  }
}
