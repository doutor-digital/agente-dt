/**
 * Disparo de campanha: definir a campanha, montar a onda, ver a tela de aprovação, aprovar e cancelar.
 *
 * QUEM PODE O QUÊ — a regra que importa:
 *  - ler, montar, definir campanha, cancelar: chave de serviço OU sessão de super-admin (é só preparar ou parar);
 *  - APROVAR: só sessão de super-admin cujo e-mail está em DISPARO_APROVADORES. A chave de serviço NÃO aprova:
 *    ela é a que as sessões do Claude e as rotinas usam, e "o robô aprova o próprio disparo" é o que esta tela existe
 *    para impedir. A tela fica no console (e não na página pública com código de unidade, como a /pausa): quem aprova
 *    uma onda é uma decisão de rede, e a página de unidade se abre com um código que a recepção conhece.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { estadoDaAutomacao } from '../lib/automacoes-estado.js';
import { abrirOnda, aprovarOnda, cancelarOnda, concluirMontagem, definicaoDaOnda } from '../lib/disparo/onda.js';
import { conferirModeloNaMeta, podeAprovar } from '../lib/disparo/modelo.js';
import { montarPainelDaOnda, telefoneMascarado } from '../lib/disparo/painel.js';
import { problemaNoModelo } from '../lib/disparo/regras.js';
import { freiosDoAmbiente } from '../lib/disparo/freios.js';
import { AUTOMACAO_DISPARO, listaDeTesteDoAmbiente } from '../lib/disparo/porto.js';

const cabecalho = z.object({ tipo: z.enum(['image', 'video', 'document']), link: z.string().url().startsWith('https://'), nomeArquivo: z.string().max(120).optional() });

const campanhaSchema = z.object({
  nome: z.string().min(2).max(120),
  template: z.string().min(1).max(512).nullish(),
  idioma: z.string().min(2).max(12).default('pt_BR'),
  textoModelo: z.string().min(1).max(4096),
  variaveis: z.array(z.string().min(1).max(200)).max(10).default([]),
  cabecalho: cabecalho.nullish(),
  porUnidade: z.record(z.object({ template: z.string().min(1).max(512).optional(), cabecalho: cabecalho.nullish() })).default({}),
});

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/);

export async function disparoCampanhaPutHandler(req: Request, res: Response): Promise<void> {
  const slug = slugSchema.safeParse(req.params.slug);
  const corpo = campanhaSchema.safeParse(req.body);
  if (!slug.success || !corpo.success) {
    res.status(400).json({ ok: false, erro: 'campanha inválida', detalhe: corpo.success ? undefined : corpo.error.flatten() });
    return;
  }
  const c = corpo.data;
  const problema = problemaNoModelo(c.textoModelo, c.variaveis);
  if (problema) {
    res.status(422).json({ ok: false, erro: problema });
    return;
  }
  const dados = {
    nome: c.nome,
    template: c.template ?? null,
    idioma: c.idioma,
    textoModelo: c.textoModelo,
    variaveis: c.variaveis as Prisma.InputJsonValue,
    cabecalho: c.cabecalho ? (c.cabecalho as Prisma.InputJsonValue) : Prisma.DbNull,
    porUnidade: c.porUnidade as Prisma.InputJsonValue,
  };
  const salva = await prisma.disparoCampanha.upsert({ where: { slug: slug.data }, create: { slug: slug.data, ...dados }, update: dados });
  res.json({ ok: true, campanha: { id: salva.id, slug: salva.slug } });
}

export async function disparoOndaCriarHandler(req: Request, res: Response): Promise<void> {
  const corpo = z.object({ campanha: slugSchema, unidade: z.string().min(2).max(120), etiqueta: z.string().min(1).max(200) }).safeParse(req.body);
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

async function dadosDaTela(ondaId: string, email: string | null | undefined) {
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true, campanha: { select: { nome: true } } } });
  if (!onda) return null;
  const [porEstado, simulados, amostra] = await Promise.all([
    prisma.disparoDestinatario.groupBy({ by: ['estado'], where: { ondaId }, _count: true }),
    prisma.disparoDestinatario.count({ where: { ondaId, simuladoEm: { not: null } } }),
    prisma.disparoDestinatario.findMany({ where: { ondaId }, orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }], take: 15, select: { nome: true, telefone: true } }),
  ]);
  // Só pergunta à Meta enquanto ainda dá para aprovar: é a prova que destrava (ou trava) o botão.
  const conferenciaMeta = onda.estado === 'montada' ? await conferirModeloNaMeta(onda.unit, definicaoDaOnda(onda)) : null;
  const teste = listaDeTesteDoAmbiente();
  return {
    onda: { ...definicaoDaOnda(onda), id: onda.id, estado: onda.estado, total: onda.total, etiqueta: onda.etiqueta, impressao: onda.impressao, aprovadaPor: onda.aprovadaPor, aprovadaEm: onda.aprovadaEm, pausaMotivo: onda.pausaMotivo },
    campanhaNome: onda.campanha.nome,
    unidade: { slug: onda.unit.slug, nome: onda.unit.name },
    modo: estadoDaAutomacao(onda.unit.slug, AUTOMACAO_DISPARO, process.env.DISPARO_CAMPANHA_SLUGS),
    freios: freiosDoAmbiente(),
    resumo: (onda.resumo ?? {}) as Record<string, never>,
    contagem: Object.fromEntries(porEstado.map((g) => [g.estado, g._count])),
    simulados,
    amostra,
    conferenciaMeta,
    podeAprovar: podeAprovar(email),
    listaDeTeste: teste ? [...teste] : null,
  };
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
