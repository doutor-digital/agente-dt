/**
 * Rotas do painel do suporte (suporte.doutordigitalconsultoria.com). Só administrador geral (João e Suzanne): `requireAuth` +
 * `requireSuperAdmin` na rota. As regras moram em `lib/suporte-painel.ts`; aqui só banco e envio.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { enviarTelegramChamados } from '../lib/telegram.js';
import { criarEnviadorEvolution, lerConfig } from '../lib/suporte-menu.js';
import { armazemPausaPrisma, menuPausado } from '../lib/suporte-pausa-banco.js';
import { mudarPeloPainel } from '../lib/suporte-pausa.js';
import type { Passo } from '../lib/suporte-menu-maquina.js';
import {
  lerItemDeConhecimento,
  reabrirPeloPainel,
  resolverDemanda,
  type DepsPainel,
  type StatusDemanda,
} from '../lib/suporte-painel.js';

const STATUS: readonly string[] = ['aberta', 'resolvida', 'reaberta'];

function depsReais(): DepsPainel {
  const menu = lerConfig();
  const enviar = criarEnviadorEvolution(menu);
  return {
    agora: () => new Date(),
    async demanda(protocolo) {
      const d = await prisma.suporteDemanda.findUnique({ where: { protocolo }, select: { protocolo: true, jid: true, status: true } });
      return d ? { protocolo: d.protocolo, jid: d.jid, status: d.status as StatusDemanda } : null;
    },
    async conversa(jid) {
      const c = await prisma.suporteConversa.findUnique({ where: { jid }, select: { passo: true, protocolo: true, versao: true } });
      return c ? { passo: c.passo as Passo, protocolo: c.protocolo, versao: c.versao } : null;
    },
    async marcarResolvida(protocolo, { quem, nota, quando }) {
      await prisma.suporteDemanda.update({ where: { protocolo }, data: { status: 'resolvida', resolvidaEm: quando, resolvidaPor: quem, notaResolucao: nota } });
    },
    async conversaParaResolvida(jid, versao, quando) {
      const r = await prisma.suporteConversa.updateMany({
        where: { jid, versao },
        data: { passo: 'resolvida', tentativas: 0, atualizadoEm: quando, versao: { increment: 1 } },
      });
      return r.count === 1;
    },
    // pausado = o menu não fala com ninguém: marcar como resolvida NÃO manda o "pode testar?" (a resposta da pessoa seria descartada)
    menuLigado: async () => menu.modo === 'ligado' && !(await menuPausado()),
    async enviarWhatsApp(jid, texto) {
      const ok = await enviar(jid, texto);
      if (ok) await prisma.suporteEnvio.create({ data: { jid, nova: false } });
      return ok;
    },
    telegram: (texto) => enviarTelegramChamados(texto),
    async reabrir(protocolo) {
      await prisma.suporteDemanda.update({ where: { protocolo }, data: { status: 'reaberta', reabertaEm: new Date(), vezesReaberta: { increment: 1 } } });
    },
  };
}

const quem = (req: Request) => req.user?.email ?? req.user?.id ?? 'painel';
const protocoloDe = (req: Request): number | null => {
  const n = Number(req.params.protocolo);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function listarDemandasHandler(req: Request, res: Response): Promise<void> {
  const status = typeof req.query.status === 'string' && STATUS.includes(req.query.status) ? req.query.status : null;
  const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
  const [demandas, contagem] = await Promise.all([
    prisma.suporteDemanda.findMany({ where: status ? { status } : {}, orderBy: { protocolo: 'desc' }, take: limite }),
    prisma.suporteDemanda.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  res.json({
    demandas: demandas.map((d) => ({
      protocolo: d.protocolo,
      criadoEm: d.criadoEm,
      numero: d.jid.endsWith('@lid') ? null : `+${d.jid.split('@')[0]}`,
      nome: d.nome,
      unidadeSlug: d.unidadeSlug,
      verificacao: d.verificacao,
      gruposVistos: d.gruposVistos,
      categoria: d.categoriaNome,
      relato: d.relato,
      status: d.status,
      prioridade: d.prioridade,
      prazoEm: d.prazoEm,
      analise: d.analise,
      analiseFalha: d.analiseFalha,
      resolvidaEm: d.resolvidaEm,
      resolvidaPor: d.resolvidaPor,
      notaResolucao: d.notaResolucao,
      vezesReaberta: d.vezesReaberta,
      claude: d.claudeStatus
        ? {
            status: d.claudeStatus,
            autorizadoPor: d.claudeAutorizadoPor,
            iniciadoEm: d.claudeIniciadoEm,
            terminadoEm: d.claudeTerminadoEm,
            resumo: d.claudeResumo,
            prUrl: d.claudePrUrl,
            precisaPessoa: d.claudePrecisaPessoa,
            oQueFazer: d.claudeOQueFazer,
          }
        : null,
    })),
    contagem: Object.fromEntries(contagem.map((c) => [c.status, c._count._all])),
  });
}

export async function resolverHandler(req: Request, res: Response): Promise<void> {
  const p = protocoloDe(req);
  if (!p) {
    res.status(400).json({ error: 'protocolo inválido' });
    return;
  }
  const r = await resolverDemanda(p, quem(req), (req.body as { nota?: unknown } | undefined)?.nota, depsReais());
  if (!r.ok) {
    res.status(r.status).json({ error: r.erro });
    return;
  }
  logger.info({ protocolo: p, perguntou: r.perguntou, whatsapp: r.whatsapp }, 'suporte-painel: demanda resolvida');
  res.json(r);
}

export async function reabrirHandler(req: Request, res: Response): Promise<void> {
  const p = protocoloDe(req);
  if (!p) {
    res.status(400).json({ error: 'protocolo inválido' });
    return;
  }
  const r = await reabrirPeloPainel(p, quem(req), depsReais());
  if (!r.ok) {
    res.status(r.status ?? 400).json({ error: r.erro });
    return;
  }
  res.json(r);
}

export async function listarConhecimentoHandler(_req: Request, res: Response): Promise<void> {
  const itens = await prisma.suporteConhecimento.findMany({ orderBy: [{ ativo: 'desc' }, { atualizadoEm: 'desc' }] });
  res.json({ itens });
}

export async function criarConhecimentoHandler(req: Request, res: Response): Promise<void> {
  const r = lerItemDeConhecimento(req.body);
  if (!r.ok) {
    res.status(400).json({ error: r.erro });
    return;
  }
  const item = await prisma.suporteConhecimento.create({
    data: { titulo: r.dados.titulo!, texto: r.dados.texto!, ativo: r.dados.ativo ?? true, autor: quem(req) },
  });
  res.status(201).json({ item });
}

export async function editarConhecimentoHandler(req: Request, res: Response): Promise<void> {
  const r = lerItemDeConhecimento(req.body, true);
  if (!r.ok) {
    res.status(400).json({ error: r.erro });
    return;
  }
  const id = String(req.params.id);
  const existe = await prisma.suporteConhecimento.findUnique({ where: { id }, select: { id: true } });
  if (!existe) {
    res.status(404).json({ error: 'item não encontrado' });
    return;
  }
  const item = await prisma.suporteConhecimento.update({ where: { id }, data: { ...r.dados, autor: quem(req) } });
  res.json({ item });
}

export async function apagarConhecimentoHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const r = await prisma.suporteConhecimento.deleteMany({ where: { id } });
  if (r.count === 0) {
    res.status(404).json({ error: 'item não encontrado' });
    return;
  }
  res.json({ ok: true });
}

// ─── pausa do menu (botão Pausar/Retomar; a mesma chave do /pausar do @ddchamados_bot) ──────────────────────

/** O que o painel mostra: a pausa e em que modo o servidor está (pausar um menu `desligado` não muda nada na prática). */
function corpoDaPausa(estado: Awaited<ReturnType<typeof armazemPausaPrisma.ler>>) {
  return { pausado: estado.pausado, desde: estado.desde, por: estado.por, ignoradas: estado.ignoradas, menu: lerConfig().modo };
}

export async function lerPausaHandler(_req: Request, res: Response): Promise<void> {
  res.json(corpoDaPausa(await armazemPausaPrisma.ler()));
}

export async function mudarPausaHandler(req: Request, res: Response): Promise<void> {
  const pausado = (req.body as { pausado?: unknown } | undefined)?.pausado;
  if (typeof pausado !== 'boolean') {
    res.status(400).json({ error: 'informe pausado: true ou false' });
    return;
  }
  const r = await mudarPeloPainel(pausado, quem(req), { pausa: armazemPausaPrisma, agora: () => new Date(), modoDoMenu: () => lerConfig().modo });
  logger.info({ pausado, mudou: r.mudou, por: quem(req) }, 'suporte-painel: pausa do menu');
  // o João fica sabendo pelo Telegram também, para os dois caminhos contarem a mesma história
  if (r.aviso) void enviarTelegramChamados(r.aviso);
  res.json({ ...corpoDaPausa(r.estado), mudou: r.mudou });
}
