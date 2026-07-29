// ============================================================================
// spine.controller.ts — Agenda da franquia + kill switch da IA.
//
// O KILL SWITCH É O CORAÇÃO DISTO, não um acessório.
// --------------------------------------------------
// A API da franquia não conta bloqueios de agenda. Quando o médico trava um
// horário à mão, a IA continua vendo aquele slot como vago e marcaria em cima.
// Não há como consertar isso por código — o dado não existe do nosso lado.
//
// A contenção é humana: a recepção aperta o botão e a IA para de marcar na
// hora. Por isso a rota de pausa é a mais simples do sistema — sem validação
// de payload complexa, sem dependência de rede externa, sem nada que possa
// falhar. Ela grava um booleano e responde. Quem usa esse botão está no meio
// de um problema; o botão não pode ser mais um.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaService } from '../services/agenda.service.js';

/** "agora" no relógio da clínica — usa o fuso IANA da unidade. */
function agoraLocalIso(tz: string): string {
  return SpineService.instanteNoFuso(new Date(), tz || 'America/Sao_Paulo');
}

async function carregarUnidade(req: Request) {
  const unitId = String(req.params.id ?? req.body?.unitId ?? '');
  if (!unitId) return null;
  return prisma.unit.findUnique({ where: { id: unitId } });
}

// ---------------------------------------------------------------------------
// KILL SWITCH
// ---------------------------------------------------------------------------

const pauseSchema = z.object({
  unitId: z.string().min(1),
  reason: z.string().max(300).optional(),
});

export async function emergencyPauseHandler(req: Request, res: Response): Promise<void> {
  const parsed = pauseSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
    return;
  }
  const { unitId, reason } = parsed.data;

  const unit = await prisma.unit.update({
    where: { id: unitId },
    data: {
      spineAiPaused: true,
      spinePausedAt: new Date(),
      spinePausedReason: reason ?? 'intercorrência na agenda',
    },
    select: { id: true, slug: true, spineAiPaused: true, spinePausedAt: true, spinePausedReason: true },
  });

  // Log em nível warn de propósito: pausa é evento de incidente e precisa
  // aparecer no painel de Erros junto com o resto do que aconteceu naquela
  // janela de tempo. É o que permite reconstruir o dia depois.
  logger.warn({ unit: unit.slug, reason: unit.spinePausedReason }, 'KILL SWITCH: IA pausada');

  res.json({ ok: true, unit });
}

export async function resumeHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.body?.unitId ?? '');
  if (!unitId) {
    res.status(400).json({ error: 'unitId_obrigatorio' });
    return;
  }
  const unit = await prisma.unit.update({
    where: { id: unitId },
    data: { spineAiPaused: false, spinePausedAt: null, spinePausedReason: null },
    select: { id: true, slug: true, spineAiPaused: true },
  });
  logger.warn({ unit: unit.slug }, 'KILL SWITCH: IA reativada');
  res.json({ ok: true, unit });
}

export async function spineStatusHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  res.json({
    enabled: unit.spineEnabled,
    hasToken: !!unit.spineToken,
    baseUrl: unit.spineBaseUrl,
    paused: unit.spineAiPaused,
    pausedAt: unit.spinePausedAt,
    pausedReason: unit.spinePausedReason,
    timezone: unit.spineTimezone,
    agenda: {
      start: unit.spineAgendaStart,
      end: unit.spineAgendaEnd,
      lunchStart: unit.spineLunchStart,
      lunchEnd: unit.spineLunchEnd,
      days: unit.spineAgendaDays,
      slotMinutes: unit.spineSlotMinutes,
    },
  });
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

const rangeSchema = z.object({
  initialDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function spineSchedulesHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const tz = unit.spineTimezone;
  const hoje = agoraLocalIso(tz).slice(0, 10);
  const parsed = rangeSchema.safeParse({
    initialDate: req.query.initialDate ?? hoje,
    endDate: req.query.endDate ?? hoje,
  });
  if (!parsed.success) {
    res.status(400).json({ error: 'datas_invalidas', detail: parsed.error.flatten() });
    return;
  }

  // A doc da franquia limita buscas por período a 100 dias. Cortar aqui dá
  // erro nosso, legível, em vez de um 400 opaco vindo de fora.
  const dias =
    (Date.parse(parsed.data.endDate) - Date.parse(parsed.data.initialDate)) / 86_400_000;
  if (dias < 0 || dias > 100) {
    res.status(400).json({ error: 'intervalo_invalido', detail: 'máximo de 100 dias' });
    return;
  }

  const r = await SpineService.searchSchedules(unit, parsed.data);
  if (!r.ok || !r.data) {
    res.status(502).json({ error: 'spine_indisponivel', detail: r.error });
    return;
  }

  const slots = AgendaService.buildAgenda(
    {
      start: unit.spineAgendaStart,
      end: unit.spineAgendaEnd,
      lunchStart: unit.spineLunchStart,
      lunchEnd: unit.spineLunchEnd,
      days: unit.spineAgendaDays,
      slotMinutes: unit.spineSlotMinutes,
    },
    r.data.schedules,
    parsed.data,
    agoraLocalIso(tz),
  );

  res.json({
    paused: unit.spineAiPaused,
    range: parsed.data,
    schedules: r.data.schedules,
    total: r.data.total,
    pages: r.data.pages,
    slots,
    resumo: {
      livres: slots.filter((s) => s.status === 'livre').length,
      ocupados: slots.filter((s) => s.status === 'ocupado').length,
      incertos: slots.filter((s) => s.status === 'incerto').length,
    },
  });
}

export async function spinePingHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const r = await SpineService.ping(unit);
  res.status(r.ok ? 200 : 502).json(r);
}
