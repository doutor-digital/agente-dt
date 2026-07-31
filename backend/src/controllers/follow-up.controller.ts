// ============================================================================
// follow-up.controller.ts — Regras de reengajamento por etapa.
//
// A TELA PRECISA MOSTRAR O QUE NÃO EXISTE AINDA
// ---------------------------------------------
// Uma listagem só do que está no banco começaria vazia, e tela vazia não
// ensina nada — quem abre não descobre que dá pra reengajar quem foi perdido
// por "achou caro". Então a listagem devolve as regras SALVAS mescladas com os
// modelos prontos, marcando quais ainda não foram criados. A pessoa vê o
// cardápio inteiro e liga o que quiser.
//
// E devolve também os MOTIVOS INTOCÁVEIS, com o porquê de cada um. Eles não
// são configuráveis de propósito, mas precisam aparecer: uma regra invisível é
// uma regra que ninguém entende, e alguém vai perguntar por que "sem condições
// financeiras" não está na lista.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { PRESETS, MOTIVOS_INTOCAVEIS } from '../lib/follow-up-presets.js';

async function carregarUnidade(req: Request) {
  const unitId = String(req.params.id ?? '');
  if (!unitId) return null;
  return prisma.unit.findUnique({ where: { id: unitId } });
}

/** Chave que identifica uma regra: etapa + motivo (nulo = qualquer motivo). */
function chave(statusId: number, lossReasonId: number | null): string {
  return `${statusId}:${lossReasonId ?? 'null'}`;
}

export async function listFollowUpRulesHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  const salvas = await prisma.followUpRule.findMany({
    where: { unitId: unit.id },
    orderBy: [{ statusId: 'asc' }, { lossReasonId: 'asc' }],
  });
  const porChave = new Map(salvas.map((r) => [chave(r.statusId, r.lossReasonId), r]));

  // Modelo pronto + o que está salvo por cima. `existe: false` diz à tela que
  // aquilo é sugestão, não configuração — a diferença entre "está desligado" e
  // "nunca foi criado".
  interface RegraNaTela {
    id: string | null;
    existe: boolean;
    statusId: number;
    statusName: string;
    lossReasonId: number | null;
    lossReasonName: string | null;
    enabled: boolean;
    notes: string | null;
    steps: unknown;
    editada: boolean;
  }

  const regras: RegraNaTela[] = PRESETS.map((p) => {
    const salva = porChave.get(chave(p.statusId, p.lossReasonId));
    porChave.delete(chave(p.statusId, p.lossReasonId));
    return {
      id: salva?.id ?? null,
      existe: !!salva,
      statusId: p.statusId,
      statusName: p.statusName,
      lossReasonId: p.lossReasonId,
      lossReasonName: p.lossReasonName,
      enabled: salva?.enabled ?? false,
      notes: salva?.notes ?? p.notes,
      steps: (salva?.steps as unknown) ?? p.steps,
      /** True quando a escada salva foi editada e não bate mais com o modelo. */
      editada: salva ? JSON.stringify(salva.steps) !== JSON.stringify(p.steps) : false,
    };
  });

  // Regras que a pessoa criou fora do cardápio continuam aparecendo — senão
  // sumiriam da tela e ficariam rodando invisíveis.
  for (const extra of porChave.values()) {
    regras.push({
      id: extra.id,
      existe: true,
      statusId: extra.statusId,
      statusName: `Etapa ${extra.statusId}`,
      lossReasonId: extra.lossReasonId,
      lossReasonName: extra.lossReasonName,
      enabled: extra.enabled,
      notes: extra.notes,
      steps: extra.steps as unknown,
      editada: false,
    });
  }

  res.json({
    followUpEnabled: unit.followUpEnabled,
    regras,
    intocaveis: MOTIVOS_INTOCAVEIS,
    ligadas: regras.filter((r) => r.enabled).length,
  });
}

const stepSchema = z.object({
  aposMin: z.number().int().min(1).max(23 * 60),
  intencao: z.string().min(10).max(1200),
});

const upsertSchema = z.object({
  statusId: z.number().int().positive(),
  lossReasonId: z.number().int().positive().nullable().optional(),
  lossReasonName: z.string().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
  notes: z.string().max(400).nullable().optional(),
  steps: z.array(stepSchema).max(8).optional(),
});

export async function upsertFollowUpRuleHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const parsed = upsertSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
    return;
  }
  const { statusId, lossReasonId = null, lossReasonName = null, enabled, notes, steps } = parsed.data;

  // Motivo intocável não vira regra, nem desligada. Bloquear aqui e não só na
  // tela é o que garante que ninguém habilite por outro caminho.
  if (MOTIVOS_INTOCAVEIS.some((m) => m.id === lossReasonId)) {
    const m = MOTIVOS_INTOCAVEIS.find((x) => x.id === lossReasonId)!;
    res.status(422).json({
      error: 'motivo_intocavel',
      detail: `"${m.nome}" não recebe reengajamento automático: ${m.porque}.`,
    });
    return;
  }

  // Degraus fora de ordem quebram o espaçamento do worker, que assume
  // crescente. Ordenar aqui evita uma classe inteira de bug silencioso.
  const escada = steps ? [...steps].sort((a, b) => a.aposMin - b.aposMin) : undefined;

  const base = PRESETS.find((p) => p.statusId === statusId && p.lossReasonId === lossReasonId);
  const regra = await prisma.followUpRule.upsert({
    where: {
      // O Prisma tipa a chave composta como não-nula, mas a coluna aceita NULL
      // e o unique do Postgres trata NULL como valor distinto — que é
      // exatamente o comportamento que queremos: uma regra "sem motivo" por
      // etapa, mais uma por motivo.
      unitId_statusId_lossReasonId: {
        unitId: unit.id,
        statusId,
        lossReasonId: lossReasonId as number,
      },
    },
    create: {
      unitId: unit.id,
      statusId,
      lossReasonId,
      lossReasonName: lossReasonName ?? base?.lossReasonName ?? null,
      enabled: enabled ?? false,
      notes: notes ?? base?.notes ?? null,
      steps: (escada ?? base?.steps ?? []) as object,
    },
    update: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(escada ? { steps: escada as object } : {}),
    },
  });

  logger.info(
    { unit: unit.slug, statusId, lossReasonId, enabled: regra.enabled },
    'follow-up: regra salva',
  );
  res.json({ ok: true, regra });
}

/** Liga/desliga o reengajamento da unidade inteira — a chave geral. */
export async function toggleFollowUpHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const enabled = Boolean(req.body?.enabled);
  await prisma.unit.update({ where: { id: unit.id }, data: { followUpEnabled: enabled } });
  logger.warn({ unit: unit.slug, enabled }, 'follow-up: chave geral alterada');
  res.json({ ok: true, followUpEnabled: enabled });
}
