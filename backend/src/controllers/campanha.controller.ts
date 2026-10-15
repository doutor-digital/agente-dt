/**
 * Placar de campanha: os dados (JSON), a coleta na hora e a página. As três rotas exigem a chave de
 * serviço ou a sessão de super-admin do console — a página mostra primeiro nome de paciente.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { campanhaPorId, type Campanha } from '../lib/campanha/campanhas.js';
import { coletarEGravar } from '../lib/campanha/coleta.js';
import { DIA_DA_TELA, juntarComATela, montarPainel, type DaTela, type Foto } from '../lib/campanha/painel.js';

const coletando = new Set<string>();

async function ultimaFoto(campanha: Campanha): Promise<{ dia: string | null; unidades: Foto[]; dias: string[] }> {
  const dias = (
    await prisma.campanhaPlacar.findMany({
      where: { campanha: campanha.id, dia: { not: DIA_DA_TELA } },
      distinct: ['dia'],
      select: { dia: true },
      orderBy: { dia: 'desc' },
    })
  ).map((d) => d.dia);
  const dia = dias[0] ?? null;
  if (!dia) return { dia: null, unidades: [], dias };
  const linhas = await prisma.campanhaPlacar.findMany({ where: { campanha: campanha.id, dia } });
  const tela = new Map(
    (await prisma.campanhaPlacar.findMany({ where: { campanha: campanha.id, dia: DIA_DA_TELA } })).map((t) => [t.unidade, (t.dados as { grupos?: DaTela }).grupos]),
  );
  const ordem = new Map(campanha.unidades.map((s, i) => [s, i]));
  const unidades = linhas
    .map((l) => juntarComATela(l.dados as unknown as Foto, tela.get(l.unidade)))
    .sort((a, b) => (ordem.get(a.unidade) ?? 99) - (ordem.get(b.unidade) ?? 99));
  return { dia, unidades, dias };
}

export async function campanhaPlacarHandler(req: Request, res: Response): Promise<void> {
  const campanha = campanhaPorId(String(req.params.id));
  if (!campanha) {
    res.status(404).json({ ok: false, error: 'campanha não encontrada' });
    return;
  }
  res.json({ ok: true, campanha: { id: campanha.id, nome: campanha.nome, inicio: campanha.inicio, fim: campanha.fim }, ...(await ultimaFoto(campanha)) });
}

export async function campanhaColetarHandler(req: Request, res: Response): Promise<void> {
  const campanha = campanhaPorId(String(req.params.id));
  if (!campanha) {
    res.status(404).json({ ok: false, error: 'campanha não encontrada' });
    return;
  }
  if (coletando.has(campanha.id)) {
    res.status(409).json({ ok: false, error: 'a coleta desta campanha já está rodando' });
    return;
  }
  coletando.add(campanha.id);
  // Leva alguns minutos (9 contas, fila do Kommo dividida com a Sofia): responde já e grava no fim.
  void coletarEGravar(campanha)
    .catch((err) => logger.error({ err, campanha: campanha.id }, 'placar de campanha: coleta manual falhou'))
    .finally(() => coletando.delete(campanha.id));
  res.status(202).json({ ok: true, mensagem: 'coleta iniciada; a página atualiza quando terminar (uns 5 minutos)' });
}

/** Grava os números da tela "Transmissões" de uma unidade: `{ unidade, grupos: { 'dia-1': { entregues, lidas, … } } }`. */
export async function campanhaTelaHandler(req: Request, res: Response): Promise<void> {
  const campanha = campanhaPorId(String(req.params.id));
  if (!campanha) {
    res.status(404).json({ ok: false, error: 'campanha não encontrada' });
    return;
  }
  const corpo = (req.body ?? {}) as { unidade?: unknown; grupos?: unknown };
  const unidade = typeof corpo.unidade === 'string' ? corpo.unidade : '';
  if (!campanha.unidades.includes(unidade) || !corpo.grupos || typeof corpo.grupos !== 'object') {
    res.status(400).json({ ok: false, error: 'mande { unidade, grupos } com uma unidade da campanha' });
    return;
  }
  const campos = ['enviadas', 'entregues', 'lidas', 'respondidas', 'falhas', 'custoUsd'] as const;
  const grupos: DaTela = {};
  for (const [chave, v] of Object.entries(corpo.grupos as Record<string, Record<string, unknown>>)) {
    if (!/^[a-z0-9-]{1,40}$/.test(chave) || !v || typeof v !== 'object') continue;
    grupos[chave] = {};
    for (const c of campos) if (typeof v[c] === 'number' && Number.isFinite(v[c]) && (v[c] as number) >= 0) grupos[chave]![c] = v[c] as number;
  }
  const dados = { grupos, atualizadoEm: new Date().toISOString() };
  await prisma.campanhaPlacar.upsert({
    where: { campanha_unidade_dia: { campanha: campanha.id, unidade, dia: DIA_DA_TELA } },
    create: { campanha: campanha.id, unidade, dia: DIA_DA_TELA, dados },
    update: { dados },
  });
  res.json({ ok: true, unidade, grupos: Object.keys(grupos) });
}

export async function campanhaPainelHandler(req: Request, res: Response): Promise<void> {
  const campanha = campanhaPorId(String(req.params.id));
  if (!campanha) {
    res.status(404).type('text/plain').send('campanha não encontrada');
    return;
  }
  const { dia, unidades } = await ultimaFoto(campanha);
  res.type('html').send(montarPainel(campanha, dia, unidades));
}
