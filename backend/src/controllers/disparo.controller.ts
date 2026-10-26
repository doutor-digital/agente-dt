/**
 * Disparo de campanha: definir a campanha, montar a onda, ver a tela de aprovação, aprovar, retomar e cancelar.
 *
 * QUEM PODE O QUÊ — a regra que importa:
 *  - ler, montar, definir campanha, cancelar: chave de serviço OU sessão de super-admin (é só preparar ou parar);
 *  - APROVAR e RETOMAR (onda parada por SAIR): só sessão de super-admin cujo e-mail está em DISPARO_APROVADORES. A chave de serviço NÃO aprova:
 *    ela é a que as sessões do Claude e as rotinas usam, e "o robô aprova o próprio disparo" é o que esta tela existe
 *    para impedir. A tela fica no console (e não na página pública com código de unidade, como a /pausa): quem aprova
 *    uma onda é uma decisão de rede, e a página de unidade se abre com um código que a recepção conhece.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { abrirOnda, aprovarOnda, cancelarOnda, concluirMontagem, retomarOnda } from '../lib/disparo/onda.js';
import { montarPainelDaOnda, telefoneMascarado } from '../lib/disparo/painel.js';
import { dadosDaTela } from '../lib/disparo/tela.js';
import { campanhaSchema, salvarCampanha, slugDaCampanha } from '../lib/disparo/campanha.js';

export async function disparoCampanhaPutHandler(req: Request, res: Response): Promise<void> {
  const slug = slugDaCampanha.safeParse(req.params.slug);
  const corpo = campanhaSchema.safeParse(req.body);
  if (!slug.success || !corpo.success) {
    res.status(400).json({ ok: false, erro: 'campanha inválida', detalhe: corpo.success ? undefined : corpo.error.flatten() });
    return;
  }
  const r = await salvarCampanha(slug.data, corpo.data);
  if (!r.ok) {
    res.status(r.status).json({ ok: false, erro: r.erro });
    return;
  }
  res.json({ ok: true, campanha: { id: r.dados.id, slug: r.dados.slug } });
}

export async function disparoOndaCriarHandler(req: Request, res: Response): Promise<void> {
  const corpo = z.object({ campanha: slugDaCampanha, unidade: z.string().min(2).max(120), etiqueta: z.string().min(1).max(200) }).safeParse(req.body);
  if (!corpo.success) {
    res.status(400).json({ ok: false, erro: 'mande { campanha, unidade, etiqueta }' });
    return;
  }
  const r = await abrirOnda({ ...corpo.data, por: req.user?.email ?? 'chave-de-servico' });
  if (!r.ok) {
    res.status(r.status).json({ ok: false, erro: r.erro });
    return;
  }
  // Montar leva minutos (Kommo + franquia por pessoa): responde já; a tela mostra "montando…" até acabar.
  void concluirMontagem(r.dados.id).catch((err) => logger.error({ err: String(err), onda: r.dados.id }, 'disparo: montagem estourou'));
  res.status(202).json({ ok: true, onda: r.dados.id, painel: `/api/disparo/ondas/${r.dados.id}/painel` });
}

export async function disparoOndasListarHandler(_req: Request, res: Response): Promise<void> {
  const ondas = await prisma.disparoOnda.findMany({
    orderBy: { criadoEm: 'desc' },
    take: 50,
    select: { id: true, estado: true, total: true, etiqueta: true, criadoEm: true, pausaMotivo: true, campanha: { select: { slug: true } }, unit: { select: { slug: true } } },
  });
  res.json({ ok: true, ondas: ondas.map((o) => ({ id: o.id, campanha: o.campanha.slug, unidade: o.unit.slug, etiqueta: o.etiqueta, estado: o.estado, total: o.total, criadoEm: o.criadoEm, motivo: o.pausaMotivo })) });
}

export async function disparoOndaJsonHandler(req: Request, res: Response): Promise<void> {
  const dados = await dadosDaTela(String(req.params.id), req.user?.email);
  if (!dados) {
    res.status(404).json({ ok: false, erro: 'onda não encontrada' });
    return;
  }
  res.json({ ok: true, ...dados, amostra: dados.amostra.map((a) => ({ nome: a.nome, telefone: telefoneMascarado(a.telefone) })), listaDeTeste: dados.listaDeTeste?.map(telefoneMascarado) ?? null });
}

export async function disparoOndaPainelHandler(req: Request, res: Response): Promise<void> {
  const dados = await dadosDaTela(String(req.params.id), req.user?.email);
  if (!dados) {
    res.status(404).type('text/plain').send('onda não encontrada');
    return;
  }
  res.set('Cache-Control', 'no-store').type('html').send(montarPainelDaOnda(dados));
}

/** A ÚNICA rota que libera envio. Sessão de super-admin + e-mail em DISPARO_APROVADORES; a chave de serviço nunca chega aqui. */
export async function disparoOndaAprovarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { total?: unknown; impressao?: unknown };
  const r = await aprovarOnda(String(req.params.id), { por: req.user?.email, total: corpo.total, impressao: corpo.impressao });
  if (!r.ok) {
    res.status(r.status).json({ ok: false, erro: r.erro });
    return;
  }
  res.json({ ok: true, estado: r.dados.estado, aprovadaPor: r.dados.aprovadaPor });
}

export async function disparoOndaCancelarHandler(req: Request, res: Response): Promise<void> {
  const motivo = typeof (req.body as { motivo?: unknown } | undefined)?.motivo === 'string' ? ((req.body as { motivo: string }).motivo) : 'cancelada';
  const r = await cancelarOnda(String(req.params.id), `${motivo}${req.user?.email ? ` (${req.user.email})` : ''}`);
  if (!r.ok) {
    res.status(r.status).json({ ok: false, erro: r.erro });
    return;
  }
  res.json({ ok: true, estado: r.dados.estado });
}

/**
 * Retoma uma onda que parou por SAIR. Mesma regra do aprovar: sessão de super-admin + e-mail em DISPARO_APROVADORES;
 * a chave de serviço (o Claude) nunca chega aqui. `sairam` é quantos pedidos de SAIR a tela mostrou.
 */
export async function disparoOndaRetomarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { sairam?: unknown };
  const r = await retomarOnda(String(req.params.id), { por: req.user?.email, sairam: corpo.sairam });
  if (!r.ok) {
    res.status(r.status).json({ ok: false, erro: r.erro });
    return;
  }
  res.json({ ok: true, estado: r.dados.estado, retomadaPor: r.dados.retomadaPor });
}
