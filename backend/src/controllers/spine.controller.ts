import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaService } from '../services/agenda.service.js';
import { SpineSyncService } from '../services/spine-sync.service.js';
import { createKommoClient } from '../services/kommo.service.js';

function agoraLocalIso(tz: string): string {
  return SpineService.instanteNoFuso(new Date(), tz || 'America/Sao_Paulo');
}

async function carregarUnidade(req: Request) {
  const unitId = String(req.params.id ?? req.body?.unitId ?? '');
  if (!unitId) return null;
  return prisma.unit.findUnique({ where: { id: unitId } });
}

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
    syncLeads: unit.spineSyncLeads,
    syncPatients: unit.spineSyncPatients,
    defaultSourceId: unit.spineDefaultSourceId,
    agenda: {
      start: unit.spineAgendaStart,
      end: unit.spineAgendaEnd,
      lunchStart: unit.spineLunchStart,
      lunchEnd: unit.spineLunchEnd,
      days: unit.spineAgendaDays,
      slotMinutes: unit.spineSlotMinutes,
    },
    reminder: {
      enabled: unit.reminderEnabled,
      salesbotId: unit.reminderSalesbotId,
      hourLocal: unit.reminderHourLocal,
      bloqueado: !unit.reminderSalesbotId
        ? 'sem Salesbot configurado'
        : !unit.spineEnabled || !unit.spineToken
          ? 'agenda da franquia não conectada'
          : null,
    },
  });
}

export async function updateReminderHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const parsed = z
    .object({
      enabled: z.boolean().optional(),
      salesbotId: z.number().int().positive().nullable().optional(),
      hourLocal: z.number().int().min(0).max(23).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'payload_invalido', detalhe: parsed.error.flatten() });
    return;
  }
  const { enabled, salesbotId, hourLocal } = parsed.data;

  const salesbotFinal = salesbotId !== undefined ? salesbotId : unit.reminderSalesbotId;
  if (enabled === true && !salesbotFinal) {
    res.status(422).json({ ok: false, motivo: 'configure o Salesbot antes de ligar o lembrete' });
    return;
  }

  const updated = await prisma.unit.update({
    where: { id: unit.id },
    data: {
      ...(enabled !== undefined ? { reminderEnabled: enabled } : {}),
      ...(salesbotId !== undefined ? { reminderSalesbotId: salesbotId } : {}),
      ...(hourLocal !== undefined ? { reminderHourLocal: hourLocal } : {}),
    },
    select: { reminderEnabled: true, reminderSalesbotId: true, reminderHourLocal: true },
  });
  logger.info({ unit: unit.slug, ...updated }, 'lembrete: config alterada pelo painel');
  res.json({ ok: true, reminder: updated });
}

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

  const dias =
    (Date.parse(parsed.data.endDate) - Date.parse(parsed.data.initialDate)) / 86_400_000;
  if (dias < 0 || dias > 100) {
    res.status(400).json({ error: 'intervalo_invalido', detail: 'máximo de 100 dias' });
    return;
  }

  const [r, blocks] = await Promise.all([
    SpineService.searchSchedules(unit, parsed.data),
    prisma.agendaBlock.findMany({
      where: {
        unitId: unit.id,
        dayLocal: { gte: parsed.data.initialDate, lte: parsed.data.endDate },
      },
      orderBy: [{ dayLocal: 'asc' }, { startTime: 'asc' }],
    }),
  ]);
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
    blocks,
  );

  res.json({
    paused: unit.spineAiPaused,
    range: parsed.data,
    schedules: r.data.schedules,
    total: r.data.total,
    pages: r.data.pages,
    slots,
    blocks,
    resumo: {
      livres: slots.filter((s) => s.status === 'livre').length,
      ocupados: slots.filter((s) => s.status === 'ocupado').length,
      incertos: slots.filter((s) => s.status === 'incerto').length,
      bloqueados: slots.filter((s) => s.status === 'bloqueado').length,
    },
  });
}

const blockSchema = z.object({
  dayLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  reason: z.string().max(200).nullable().optional(),
});

export async function createAgendaBlockHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const parsed = blockSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
    return;
  }
  if (parsed.data.endTime <= parsed.data.startTime) {
    res.status(400).json({ error: 'intervalo_invalido', detail: 'fim precisa ser depois do início' });
    return;
  }

  const block = await prisma.agendaBlock.create({
    data: {
      unitId,
      ...parsed.data,
      createdBy: (req as Request & { user?: { email?: string } }).user?.email ?? null,
    },
  });
  logger.info(
    { unitId, dia: block.dayLocal, de: block.startTime, ate: block.endTime },
    'agenda: horário bloqueado pela recepção',
  );
  res.status(201).json({ block });
}

const bulkSchema = z.object({
  fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).default('23:59'),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  reason: z.string().max(200).nullable().optional(),
});

const MAX_DIAS_LOTE = 180;

export async function createAgendaBlockBulkHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const parsed = bulkSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
    return;
  }
  const { fromDay, toDay, startTime, endTime, weekdays, reason } = parsed.data;
  if (toDay < fromDay) {
    res.status(400).json({ error: 'intervalo_invalido', detail: 'fim antes do início' });
    return;
  }
  if (endTime <= startTime) {
    res.status(400).json({ error: 'horario_invalido', detail: 'fim precisa ser depois do início' });
    return;
  }

  const dias: string[] = [];
  for (
    let t = Date.parse(`${fromDay}T00:00:00Z`);
    t <= Date.parse(`${toDay}T00:00:00Z`);
    t += 86_400_000
  ) {
    const d = new Date(t);
    if (weekdays && weekdays.length > 0 && !weekdays.includes(d.getUTCDay())) continue;
    dias.push(d.toISOString().slice(0, 10));
    if (dias.length > MAX_DIAS_LOTE) {
      res.status(400).json({ error: 'intervalo_longo', detail: `máximo de ${MAX_DIAS_LOTE} dias` });
      return;
    }
  }
  if (dias.length === 0) {
    res.status(400).json({ error: 'sem_dias', detail: 'nenhum dia no intervalo com esses filtros' });
    return;
  }

  const criadoPor = (req as Request & { user?: { email?: string } }).user?.email ?? null;
  const criados = await prisma.agendaBlock.createMany({
    data: dias.map((dayLocal) => ({
      unitId,
      dayLocal,
      startTime,
      endTime,
      reason: reason ?? null,
      createdBy: criadoPor,
    })),
  });

  logger.warn(
    { unitId, de: fromDay, ate: toDay, dias: dias.length, motivo: reason },
    'agenda: bloqueio em lote',
  );
  res.status(201).json({ ok: true, dias: dias.length, criados: criados.count });
}

export async function deleteAgendaBlockBulkHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const fromDay = String(req.query.fromDay ?? '');
  const toDay = String(req.query.toDay ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    res.status(400).json({ error: 'datas_invalidas' });
    return;
  }
  const r = await prisma.agendaBlock.deleteMany({
    where: { unitId, dayLocal: { gte: fromDay, lte: toDay } },
  });
  res.json({ ok: true, removidos: r.count });
}

export async function deleteAgendaBlockHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const blockId = String(req.params.blockId);
  const achado = await prisma.agendaBlock.findFirst({ where: { id: blockId, unitId } });
  if (!achado) {
    res.status(404).json({ error: 'block_not_found' });
    return;
  }
  await prisma.agendaBlock.delete({ where: { id: blockId } });
  res.json({ ok: true });
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

export async function listAgendaBlocksHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const fromDay = String(req.query.fromDay ?? '');
  const toDay = String(req.query.toDay ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    res.status(400).json({ error: 'datas_invalidas' });
    return;
  }
  const blocks = await prisma.agendaBlock.findMany({
    where: { unitId, dayLocal: { gte: fromDay, lte: toDay } },
    orderBy: [{ dayLocal: 'asc' }, { startTime: 'asc' }],
    take: 2000,
  });
  res.json({ blocks });
}

export async function syncLeadHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const kommoLeadId = Number(req.body?.kommoLeadId);
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    res.status(400).json({ error: 'kommoLeadId_obrigatorio' });
    return;
  }
  const r = await SpineSyncService.syncLeadToSpine(unit, kommoLeadId);
  res.status(r.ok ? 200 : 422).json(r);
}

export async function previewLeadHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const kommoLeadId = Number(req.body?.kommoLeadId ?? req.query?.kommoLeadId);
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    res.status(400).json({ error: 'kommoLeadId_obrigatorio' });
    return;
  }
  const preparo = await SpineSyncService.prepararLead(unit, kommoLeadId);
  res.json({
    ...preparo,
    origemLegivel: preparo.payload ? SpineService.nomeDaOrigem(preparo.payload.idSource) : null,
  });
}

export async function cancelScheduleHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const kommoLeadId = Number(req.body?.kommoLeadId);
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    res.status(400).json({ error: 'kommoLeadId_obrigatorio' });
    return;
  }

  const vinculo = await prisma.spineLeadLink.findUnique({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
  });
  if (!vinculo?.spineIdSchedule) {
    res.status(422).json({ ok: false, motivo: 'este lead não tem consulta marcada por aqui' });
    return;
  }

  const r = await SpineService.cancelSchedule(unit, vinculo.spineIdSchedule);
  if (!r.ok) {
    res.status(502).json({ ok: false, motivo: r.error ?? 'a franquia recusou o cancelamento' });
    return;
  }

  await prisma.spineLeadLink.update({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
    data: { spineIdSchedule: null, agendadoPara: null },
  });

  logger.warn(
    { unit: unit.slug, kommoLeadId, idSchedule: vinculo.spineIdSchedule, quando: vinculo.agendadoPara },
    'agenda: consulta cancelada pela recepção no painel',
  );
  res.json({ ok: true, idSchedule: vinculo.spineIdSchedule, quando: vinculo.agendadoPara });
}

export async function confirmScheduleHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const kommoLeadId = Number(req.body?.kommoLeadId);
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    res.status(400).json({ error: 'kommoLeadId_obrigatorio' });
    return;
  }

  const vinculo = await prisma.spineLeadLink.findUnique({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
  });
  if (!vinculo?.spineIdSchedule) {
    res.status(422).json({ ok: false, motivo: 'este lead não tem consulta marcada por aqui' });
    return;
  }

  const r = await SpineService.confirmSchedule(unit, vinculo.spineIdSchedule);
  if (!r.ok) {
    res.status(502).json({ ok: false, motivo: r.error ?? 'a franquia recusou a confirmação' });
    return;
  }

  logger.info(
    { unit: unit.slug, kommoLeadId, idSchedule: vinculo.spineIdSchedule, quando: vinculo.agendadoPara },
    'agenda: presença confirmada pelo painel',
  );
  res.json({ ok: true, idSchedule: vinculo.spineIdSchedule, quando: vinculo.agendadoPara });
}

export async function biLeadsSourcesHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.spineEnabled || !unit.spineToken) {
    res.status(422).json({ ok: false, motivo: 'unidade sem a API da franquia conectada' });
    return;
  }

  const hoje = SpineService.instanteNoFuso(new Date(), unit.spineTimezone || 'America/Sao_Paulo').slice(0, 10);
  const trintaAtras = new Date(Date.parse(`${hoje}T00:00:00Z`) - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const parsed = z
    .object({ initialDate: dia.optional(), endDate: dia.optional() })
    .safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'datas_invalidas', detalhe: 'use AAAA-MM-DD' });
    return;
  }

  const r = await SpineService.biLeadsSources(unit, {
    initialDate: parsed.data.initialDate ?? trintaAtras,
    endDate: parsed.data.endDate ?? hoje,
  });
  if (!r.ok) {
    res.status(502).json({ ok: false, motivo: r.error ?? 'a franquia recusou a consulta' });
    return;
  }
  res.json({
    ok: true,
    periodo: { initialDate: parsed.data.initialDate ?? trintaAtras, endDate: parsed.data.endDate ?? hoje },
    ...r.data,
  });
}

export async function previewPatientHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const kommoLeadId = Number(req.body?.kommoLeadId ?? req.query?.kommoLeadId);
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    res.status(400).json({ error: 'kommoLeadId_obrigatorio' });
    return;
  }
  const p = await SpineSyncService.prepararPaciente(unit, kommoLeadId);
  res.json({
    ...p,
    origemLegivel: p.payload ? SpineService.nomeDaOrigem(p.payload.idSource) : null,
    requisicao: { metodo: 'POST', rota: '/api/clients', base: unit.spineBaseUrl },
  });
}

export async function syncPatientHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const kommoLeadId = Number(req.body?.kommoLeadId);
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    res.status(400).json({ error: 'kommoLeadId_obrigatorio' });
    return;
  }
  const r = await SpineSyncService.syncPatientToSpine(unit, kommoLeadId);
  res.status(r.ok ? 200 : 422).json(r);
}

export async function pendentesHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  const dias = Math.min(Math.max(Number(req.query.dias ?? 7), 1), 30);
  const desde = Math.floor(Date.now() / 1000) - dias * 86_400;

  let brutos: { id: number; name?: string | null; created_at?: number }[] = [];
  try {
    const kommo = createKommoClient(unit);
    brutos = await kommo.listLeadsDesde(desde, 100);
  } catch (err) {
    res.status(502).json({ error: 'kommo_indisponivel', message: String(err) });
    return;
  }

  const vinculos = await prisma.spineLeadLink.findMany({
    where: { unitId: unit.id, kommoLeadId: { in: brutos.map((l) => l.id) } },
  });
  const porLead = new Map(vinculos.map((v) => [v.kommoLeadId, v]));

  const leads = brutos.map((l) => {
    const v = porLead.get(l.id);
    const titulo = l.name ?? '';
    const semNome = SpineSyncService.pareceNomeAutomatico(titulo);
    return {
      kommoLeadId: l.id,
      titulo,
      nomeLimpo: semNome ? null : SpineSyncService.limparNome(titulo),
      criadoEm: l.created_at ? new Date(l.created_at * 1000).toISOString() : null,
      spineIdLead: v?.spineIdLead ?? null,
      situacao: v?.spineIdLead
        ? ('enviado' as const)
        : semNome
          ? ('sem-nome' as const)
          : v?.status === 'falhou'
            ? ('falhou' as const)
            : ('pronto' as const),
      motivo: v?.motivo ?? null,
      tentativas: v?.tentativas ?? 0,
    };
  });

  res.json({
    dias,
    leads,
    resumo: {
      pronto: leads.filter((l) => l.situacao === 'pronto').length,
      'sem-nome': leads.filter((l) => l.situacao === 'sem-nome').length,
      falhou: leads.filter((l) => l.situacao === 'falhou').length,
      enviado: leads.filter((l) => l.situacao === 'enviado').length,
    },
  });
}

export async function prontidaoHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  const pecas: { id: string; titulo: string; ok: boolean; detalhe: string; comoResolver?: string }[] = [];

  pecas.push({
    id: 'token',
    titulo: 'Token da franquia',
    ok: Boolean(unit.spineToken),
    detalhe: unit.spineToken ? 'Guardado no servidor.' : 'Nenhum token salvo.',
    comoResolver: 'Peça ao suporte da franquia e cole em Conexão.',
  });

  let apiOk = false;
  let apiDetalhe = 'Não testado — falta o token.';
  if (unit.spineToken) {
    const ping = await SpineService.ping(unit);
    apiOk = ping.ok;
    apiDetalhe = ping.ok ? 'A API respondeu com o token atual.' : (ping.error ?? 'sem resposta');
  }
  pecas.push({
    id: 'api',
    titulo: 'A API responde',
    ok: apiOk,
    detalhe: apiDetalhe,
    comoResolver: 'Token vencido ou ambiente errado — confira em Conexão.',
  });

  pecas.push({
    id: 'agenda',
    titulo: 'Agenda ligada',
    ok: unit.spineEnabled,
    detalhe: unit.spineEnabled
      ? `A IA consulta horários e agenda (${unit.spineAgendaStart}–${unit.spineAgendaEnd}, ${unit.spineTimezone}).`
      : 'A IA não consulta nem cria agendamento.',
    comoResolver: 'Ligue em Conexão com a franquia.',
  });

  pecas.push({
    id: 'espelhamento',
    titulo: 'Espelhar leads no CRM',
    ok: unit.spineSyncLeads,
    detalhe: unit.spineSyncLeads
      ? 'Lead novo do Kommo é cadastrado na franquia.'
      : 'Desligado — nenhum lead é enviado.',
    comoResolver: 'Ligue em Espelhar leads. Escrita é permanente: a franquia não apaga lead.',
  });

  const semNome = await prisma.spineLeadLink.count({ where: { unitId: unit.id, status: 'ignorado' } });
  const falhas = await prisma.spineLeadLink.count({ where: { unitId: unit.id, status: 'falhou' } });
  pecas.push({
    id: 'fila',
    titulo: 'Nada travado',
    ok: falhas === 0,
    detalhe:
      falhas === 0
        ? `Sem falhas.${semNome > 0 ? ` ${semNome} aguardando o nome (normal).` : ''}`
        : `${falhas} lead(s) falharam no envio.`,
    comoResolver: 'Veja o motivo na lista abaixo — cada linha traz o erro da franquia.',
  });

  res.json({ pecas, prontas: pecas.filter((p) => p.ok).length, total: pecas.length });
}

export async function listLeadLinksHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }

  const inicioHoje = new Date();
  inicioHoje.setUTCHours(0, 0, 0, 0);

  const [links, porStatus, hojeOk] = await Promise.all([
    prisma.spineLeadLink.findMany({ where: { unitId }, orderBy: { updatedAt: 'desc' }, take: 40 }),
    prisma.spineLeadLink.groupBy({ by: ['status'], where: { unitId }, _count: { _all: true } }),
    prisma.spineLeadLink.count({ where: { unitId, status: 'ok', updatedAt: { gte: inicioHoje } } }),
  ]);

  const contagem = Object.fromEntries(porStatus.map((r) => [r.status, r._count._all]));

  let conferencia: {
    checado: boolean;
    periodo?: { de: string; ate: string };
    enviadosPorNos?: number;
    encontradosLa?: number;
    faltando?: number[];
    erro?: string;
  } = { checado: false };

  const enviadosRecentes = links.filter((l) => l.status === 'ok' && l.spineIdLead);
  if (unit.spineToken && enviadosRecentes.length > 0) {
    const tz = unit.spineTimezone || 'America/Sao_Paulo';
    const hoje = SpineService.instanteNoFuso(new Date(), tz).slice(0, 10);
    const de = new Date(Date.parse(`${hoje}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    const ate = new Date(Date.parse(`${hoje}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const r = await SpineService.searchLeads(unit, { initialDate: de, endDate: ate });
    if (!r.ok || !r.data) {
      conferencia = { checado: false, erro: r.error ?? 'franquia não respondeu' };
    } else {
      const idsLa = new Set(r.data.leads.map((l) => l.idLead));
      const nossos = enviadosRecentes
        .filter((l) => l.updatedAt >= new Date(Date.parse(`${de}T00:00:00Z`)))
        .map((l) => l.spineIdLead as number);
      const faltando = nossos.filter((id) => !idsLa.has(id));
      conferencia = {
        checado: true,
        periodo: { de, ate: hoje },
        enviadosPorNos: nossos.length,
        encontradosLa: nossos.length - faltando.length,
        faltando,
      };
    }
  }

  res.json({
    links,
    total: links.length,
    hoje: hojeOk,
    contagem: {
      ok: contagem.ok ?? 0,
      falhou: contagem.falhou ?? 0,
      ignorado: contagem.ignorado ?? 0,
    },
    conferencia,
  });
}
