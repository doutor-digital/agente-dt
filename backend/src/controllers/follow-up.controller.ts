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
      editada: salva ? JSON.stringify(salva.steps) !== JSON.stringify(p.steps) : false,
    };
  });

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

  if (MOTIVOS_INTOCAVEIS.some((m) => m.id === lossReasonId)) {
    const m = MOTIVOS_INTOCAVEIS.find((x) => x.id === lossReasonId)!;
    res.status(422).json({
      error: 'motivo_intocavel',
      detail: `"${m.nome}" não recebe reengajamento automático: ${m.porque}.`,
    });
    return;
  }

  const escada = steps ? [...steps].sort((a, b) => a.aposMin - b.aposMin) : undefined;

  const base = PRESETS.find((p) => p.statusId === statusId && p.lossReasonId === lossReasonId);

  const existente = await prisma.followUpRule.findFirst({
    where: { unitId: unit.id, statusId, lossReasonId },
  });

  const regra = existente
    ? await prisma.followUpRule.update({
        where: { id: existente.id },
        data: {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(escada ? { steps: escada as object } : {}),
        },
      })
    : await prisma.followUpRule.create({
        data: {
          unitId: unit.id,
          statusId,
          lossReasonId,
          lossReasonName: lossReasonName ?? base?.lossReasonName ?? null,
          enabled: enabled ?? false,
          notes: notes ?? base?.notes ?? null,
          steps: (escada ?? base?.steps ?? []) as object,
        },
      });

  logger.info(
    { unit: unit.slug, statusId, lossReasonId, enabled: regra.enabled },
    'follow-up: regra salva',
  );
  res.json({ ok: true, regra });
}

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
